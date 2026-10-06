import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';

const databaseDir = path.resolve('.local-db');
const database = new EmbeddedPostgres({databaseDir, user:'splitmate', password:'splitmate_local_only',port:5433,persistent:true,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:message=>console.error(String(message))});
if (!existsSync(path.join(databaseDir,'PG_VERSION'))) await database.initialise();
await database.start();
const client = database.getPgClient();
await client.connect();
const result = await client.query("SELECT 1 FROM pg_database WHERE datname = 'splitmate'");
await client.end();
if (!result.rowCount) await database.createDatabase('splitmate');
console.log('Local PostgreSQL is ready on 127.0.0.1:5433. Keep this terminal open.');
let stopping = false;
async function stop() { if(stopping)return;stopping=true;await database.stop();process.exit(0); }
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
setInterval(()=>{},60000);
