import fs from'node:fs';const r=await fetch('http://127.0.0.1:47987/run',{method:'POST',body:fs.readFileSync(process.argv[2],'utf8')});console.log(await r.text());if(!r.ok)process.exitCode=1;
