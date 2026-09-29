// PowerShellの `"text" | wrangler secret put` は、パイプ経由でstdinへ渡す際に
// 末尾へ改行を付け足してしまうことがあり、それがそのままシークレットの値に
// 含まれてしまう（見た目は同じでも一致しなくなる）。Node の spawn で
// stdin.write() のみを行い、余計な改行を付けずに正確な値だけを渡す。
const { spawn } = require("child_process");

const [, , name, value] = process.argv;
if (!name || value === undefined) {
  console.error("usage: node set-secret.js <NAME> <VALUE>");
  process.exit(1);
}

const child = spawn("npx", ["wrangler", "secret", "put", name], {
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});
child.stdin.write(value);
child.stdin.end();
child.on("exit", (code) => process.exit(code));
