'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { quotePosix, buildExecBootstrap, createExecParser } = require('../../electron/exec-codec');

function execute(command) {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32).toString('hex');
    const peer = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, '../fixtures/pty-peer.py')], { stdio: ['pipe','pipe','pipe'] });
    const output = [];
    let pending = ''; let errors = ''; let settled = false;
    const timer = setTimeout(() => finish(new Error('Real PTY exec timed out')), 15000);
    function finish(error, result) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      peer.stdin.end(); peer.kill('SIGTERM');
      error ? reject(error) : resolve(result);
    }
    const send = input => peer.stdin.write(JSON.stringify({input})+'\n');
    const parser = createExecParser({ nonce,
      onReady:()=>send(Buffer.from(command,'utf8').toString('base64')+'\n'),
      onOutput:bytes=>output.push(Buffer.from(bytes)),
      onComplete:code=>finish(null,{code,output:Buffer.concat(output)}),
    });
    peer.stdin.on('error',error=>{if(!settled)finish(error);});
    peer.stderr.on('data',data=>{errors+=data.toString();});
    peer.on('error',finish);
    peer.on('exit',code=>{if(!settled)finish(new Error(`PTY exited before complete (${code}): ${errors}`));});
    peer.stdout.on('data',bytes=>{
      pending+=bytes.toString('utf8');
      let newline;
      while(!settled && (newline=pending.indexOf('\n'))!==-1) {
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);
        try {parser.write(JSON.parse(line).data);} catch(error){finish(error);}
      }
    });
    send(`exec sh -c ${quotePosix(buildExecBootstrap(nonce))}\n`);
  });
}

test('real POSIX PTY preserves exec bytes despite independent upstream byte decoding', {skip:process.platform==='win32'}, async () => {
  const cases = [
    ["printf '%s' ''",'',0],
    ["printf '%s' 'x'",'x',0],
    ["printf '  x\\t'",'  x\t',0],
    ["printf '\\n\\nx\\n\\n'",'\n\nx\n\n',0],
    ["printf '\\r\\n'",'\r\n',0],
    ["printf '%s' '中文🙂é'",'中文🙂é',0],
    ["printf '\\033[31mred\\033[0m\\033]0;title\\007'",'\x1b[31mred\x1b[0m\x1b]0;title\x07',0],
    ["printf '%s' \"it's quoted\"", "it's quoted",0],
    ["cat <<'EOF'\n中文🙂\nEOF\n\n",'中文🙂\n',0],
    ["read value; printf '%s' \"$?\"",'1',0],
    ["printf err >&2; exit 7",'err',7],
    ["printf '%s' '"+'x'.repeat(5000)+"'",'x'.repeat(5000),0],
  ];
  for (const [command, expected, code] of cases) {
    const result = await execute(command);
    assert.deepEqual(result.output,Buffer.from(expected,'utf8'));
    assert.equal(result.code,code);
  }
});
