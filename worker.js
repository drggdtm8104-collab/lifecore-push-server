// LifeCore 通知用 Cloudflare Worker
//
// - POST /subscribe     : 端末からの購読情報を保存する（endpoint単位で上書き、重複しない）
// - POST /unsubscribe   : 購読を解除する（同期していたタスクの一覧も一緒に消す）
// - POST /today-digest  : 今日の「時間が決まっている・まだ終わっていないタスク」の
//                         id・名前・時刻一覧を保存する（通知オン時のみクライアントから送られる）
// - 1分おき（cron）に、時刻が来た・まだ通知していないタスクを1件ずつ個別に通知する（scheduled）。
//
// v3.118（Phase 4）: 「毎朝8時にまとめて1通」（Phase 1〜3）は廃止し、時間指定
// タスクの時刻ごとに1件ずつ送る方式に置き換えた（ユーザーの指示による明示的な
// 置換）。タスクの備考・メモなどの内容は一切扱わない・保存しない——保存するのは
// 今日ぶんの「id・名前・時刻」だけで、それも通知がオンの間しかサーバーに置かれ
// ない（オフにすると同期が止まり、保存済みの一覧も削除する）。送信済み管理用の
// KV（"sent:<date>"）も2日でTTL切れになるようにしてあり、長期的にも残らない。
import { buildPushPayload } from "@block65/webcrypto-web-push";

// LifeCoreを配信しているオリジンだけCORSを許可する（他サイトから叩けない
// ようにする、SHARED_SECRETとは別の防御層）。Claude Artifact版は
// PushManager自体が使えない前提のためここには含めない。
const ALLOWED_ORIGIN = "https://drggdtm8104-collab.github.io";

function corsHeaders(extra) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-LifeCore-Token",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // v3.115の不具合修正: CORSプリフライト（OPTIONS）に何も返していな
    // かったため、GitHub Pages（別オリジン）からのfetchがブラウザ側で
    // ブロックされ、Safariで「Load failed」というエラーになっていた。
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const auth = request.headers.get("X-LifeCore-Token");

    if (url.pathname === "/subscribe" && request.method === "POST") {
      if (auth !== env.SHARED_SECRET) return new Response("unauthorized", { status: 401, headers: corsHeaders() });
      const sub = await request.json().catch(() => null);
      if (!sub || !sub.endpoint) return new Response("bad request", { status: 400, headers: corsHeaders() });
      const id = await sha256Hex(sub.endpoint);
      await env.SUBS.put("sub:" + id, JSON.stringify(sub));
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders({ "content-type": "application/json" }) });
    }

    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      if (auth !== env.SHARED_SECRET) return new Response("unauthorized", { status: 401, headers: corsHeaders() });
      const body = await request.json().catch(() => null);
      if (!body || !body.endpoint) return new Response("bad request", { status: 400, headers: corsHeaders() });
      const id = await sha256Hex(body.endpoint);
      await env.SUBS.delete("sub:" + id);
      await env.SUBS.delete("digest");   // 通知オフにしたら、保存していたタスク一覧も消す
      const jstToday = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await env.SUBS.delete("sent:" + jstToday);   // 今日ぶんの送信済み記録も一緒に消す
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders({ "content-type": "application/json" }) });
    }

    // v3.118 (Phase 4): 今日の「時間が決まっている・まだ終わっていない」タスクの
    // id・名前・時刻一覧を保存する。通知がオンの間だけクライアントから送られて
    // くる（オフなら呼ばれない）。1日でTTL切れにし、同期が止まった後も残らない
    // ようにする。
    if (url.pathname === "/today-digest" && request.method === "POST") {
      if (auth !== env.SHARED_SECRET) return new Response("unauthorized", { status: 401, headers: corsHeaders() });
      const body = await request.json().catch(() => null);
      if (!body || typeof body.date !== "string" || !Array.isArray(body.tasks)) {
        return new Response("bad request", { status: 400, headers: corsHeaders() });
      }
      const tasks = body.tasks
        .filter(t => t && typeof t.id === "string" && typeof t.name === "string" && typeof t.time === "string")
        .slice(0, 50);
      await env.SUBS.put("digest", JSON.stringify({ date: body.date, tasks }), { expirationTtl: 60 * 60 * 24 });
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders({ "content-type": "application/json" }) });
    }

    // 動作確認用: 時刻を待たずに、今すぐ全購読者へ固定文言のテスト通知を1通送る。
    // 本番の通知経路（VAPID署名・暗号化・送信）をそのまま通るため、
    // ここが通れば scheduled() 側も同じ仕組みで動く。時間指定タスクの個別通知
    // 自体を試すには、直近数分後に時刻を設定したタスクを作ってcronの実行を待つ。
    if (url.pathname === "/test-push" && request.method === "POST") {
      if (auth !== env.SHARED_SECRET) return new Response("unauthorized", { status: 401, headers: corsHeaders() });
      const result = await sendToAll(env, "テスト通知です（今すぐ送信）");
      return new Response(JSON.stringify(result), { headers: corsHeaders({ "content-type": "application/json" }) });
    }

    return new Response("LifeCore push server is running.", { status: 200, headers: corsHeaders() });
  },

  async scheduled(event, env, ctx) {
    await checkAndSendDueTasks(env, event.scheduledTime);
  },
};

// cron は * * * * *（1分おき）で起動する。保存されている今日ぶんの時間指定
// タスクのうち、時刻が来ていてまだ通知していないものを1件ずつ個別に送る。
// GRACE_MINを超えて見逃した分（アプリを長時間開いていなかった等）は、通知を
// 送らずに「送信済み」扱いにするだけにする——今さら何時間も前のタスクの通知が
// 来ても意味がなく、かえって邪魔になるため。
const GRACE_MIN = 15;

// LifeCoreの「スケジュール日は深夜4時始まり」規約（クライアント側の
// scheduleDay()/timeKey()と同じルール——0時〜3時台はまだ前日のスケジュールの
// 続きとして扱う）。これに合わせないと、深夜0時〜3時台に時刻指定した
// タスクが、その日の日中にdigestが同期された時点で「(24時間近く前の)
// 時間をとっくに過ぎている」と誤判定され、二度と通知されなくなる
// （実際に見つかった不具合）。
const NIGHT_END_HOUR = 4;
function scheduleNow(jstNow) {
  const h = jstNow.getUTCHours(), m = jstNow.getUTCMinutes();
  const scheduleMin = (h < NIGHT_END_HOUR ? h + 24 : h) * 60 + m;
  const d = new Date(jstNow);
  if (h < NIGHT_END_HOUR) d.setUTCDate(d.getUTCDate() - 1);
  return { scheduleDate: d.toISOString().slice(0, 10), scheduleMin };
}
function scheduleMinOfTime(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr || "");
  if (!m) return null;
  const h = Number(m[1]);
  return (h < NIGHT_END_HOUR ? h + 24 : h) * 60 + Number(m[2]);
}

async function checkAndSendDueTasks(env, scheduledTime, send = sendToAll) {
  const raw = await env.SUBS.get("digest");
  if (!raw) return;
  let digest;
  try {
    digest = JSON.parse(raw);
  } catch {
    return;
  }
  const jstNow = new Date((scheduledTime ?? Date.now()) + 9 * 60 * 60 * 1000);
  const { scheduleDate, scheduleMin: nowMin } = scheduleNow(jstNow);
  if (digest.date !== scheduleDate || !Array.isArray(digest.tasks) || digest.tasks.length === 0) return;

  const sentKey = "sent:" + scheduleDate;
  const sentRaw = await env.SUBS.get(sentKey);
  let sentKeys = [];
  if (sentRaw) {
    try {
      sentKeys = JSON.parse(sentRaw);
    } catch {
      sentKeys = [];
    }
  }
  const sent = new Set(sentKeys);

  let changed = false;

  for (const task of digest.tasks) {
    // 「送信済み」はid単独ではなく id+時刻 の組で管理する。id単独だと、一度
    // 鳴った後にタスクの時刻を編集して後ろにずらしても「もう送った」扱いの
    // ままになり二度と鳴らなくなってしまう（時刻を変えたら別物として扱い、
    // その新しい時刻でまた判定できるようにする）。
    const sentKeyForTask = task.id + ":" + task.time;
    if (sent.has(sentKeyForTask)) continue;
    const taskMin = scheduleMinOfTime(task.time);
    if (taskMin === null) continue;
    const diff = nowMin - taskMin;
    if (diff < 0) continue;   // まだ時間前

    sent.add(sentKeyForTask);
    changed = true;
    if (diff <= GRACE_MIN) {
      await send(env, `${task.name} の時間です`);
    }
  }

  if (changed) {
    await env.SUBS.put(sentKey, JSON.stringify([...sent]), { expirationTtl: 60 * 60 * 24 * 2 });
  }
}

async function sendToAll(env, body) {
  const vapid = {
    subject: "mailto:" + env.CONTACT_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const list = await env.SUBS.list({ prefix: "sub:" });
  let sent = 0, removed = 0, failed = 0;
  for (const key of list.keys) {
    const raw = await env.SUBS.get(key.name);
    if (!raw) continue;
    const sub = JSON.parse(raw);
    try {
      // urgency:"high" を指定し、OS側の省電力機能などでの配信の後回しを
      // 減らす（配信タイミングそのものはOS/プッシュサービス側の裁量のため、
      // 完全に即時になる保証はないが、優先度は上げられる）。
      // ttl（プッシュサービスが配信を試み続ける有効期限、秒）は
      // @block65/webcrypto-web-push のデフォルトが60秒しかなく、端末が
      // スリープ中でこの60秒を逃すとメッセージごと破棄されて二度と
      // 届かない不具合の原因になっていた（実際に朝方の通知が届かない
      // 形で発生を確認）。睡眠時間（7〜9時間程度）をまたいでも配信を
      // 保持できるよう12時間に設定し、端末が起きたタイミングで配信
      // されるようにする。
      const payload = await buildPushPayload({ data: { title: "LifeCore", body }, options: { urgency: "high", ttl: 60 * 60 * 12 } }, sub, vapid);
      const res = await fetch(sub.endpoint, payload);
      if (res.status === 404 || res.status === 410) {
        await env.SUBS.delete(key.name);
        removed++;
      } else if (res.ok) {
        sent++;
      } else {
        failed++;
      }
    } catch (e) {
      console.error("push failed for", key.name, e);
      failed++;
    }
  }
  return { sent, removed, failed, total: list.keys.length };
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// テスト用（Cloudflare Workersのデプロイには影響しない — 追加のnamed exportは無害）。
export { checkAndSendDueTasks, sendToAll };
