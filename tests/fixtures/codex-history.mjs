import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const request=JSON.parse(line);
  appendFileSync(process.env.NAUTILO_HISTORY_LOG,JSON.stringify(request)+"\n");
  if (!request.id) continue;
  let result;
  if(request.method==="initialize") result={userAgent:"fixture"};
  else if(request.method==="thread/read") result={thread:{id:request.params.threadId,createdAt:1,status:{type:"notLoaded"}}};
  else if(request.method==="thread/turns/list") {
    if(request.params.itemsView!=="full") throw Error("History must request full items");
    const turns=JSON.parse(readFileSync(process.env.NAUTILO_HISTORY_DATA,"utf8"));
    const index=request.params.cursor==="older"?1:0;
    result={data:[turns[index]],nextCursor:index===0?"older":null};
  } else throw Error(`History must not mutate native state: ${request.method}`);
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\n");
}
