import { copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if(!existsSync('.env')) copyFileSync('.env.example','.env');
const command=process.platform==='win32'?'npm.cmd':'npm';
for(const task of ['db:generate','db:migrate']) {
  const child=spawnSync(command,['run',task],{stdio:'inherit',shell:process.platform==='win32'});
  if(child.status!==0)process.exit(child.status||1);
}
console.log('Setup complete. Optional sample accounts: npm run db:seed. Start the app: npm run dev.');
