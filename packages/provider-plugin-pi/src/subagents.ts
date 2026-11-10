import type { AdapterEvent } from "@agenthub/provider-sdk";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function childEvents(value: RecordValue, name: string, seen: Map<string,string>): AdapterEvent[] {
  if (!['subagent','task','agent'].includes(name.toLowerCase()) || typeof value.toolCallId !== 'string') return [];
  const parent = value.toolCallId;
  const result = record(value.partialResult ?? value.result);
  const events: AdapterEvent[]=[];
  const push = (key:string,event:AdapterEvent) => {
    const encoded=JSON.stringify(event);
    if (seen.get(key) !== encoded) {seen.set(key,encoded);events.push(event);}
  };
  array(record(result.details).results).forEach((child,childIndex) => {
    const prefix=`${parent}:child:${childIndex}`;
    array(record(child).messages).forEach((raw,index) => {
      const message=record(raw);
      if (message.role === 'toolResult') {
        push(`${prefix}:result:${index}`,{kind:'tool',callId:`${prefix}:${message.toolCallId}`,name:String(message.toolName ?? 'tool'),phase:'completed',
          output:array(message.content).map(record).filter(part=>part.type==='text').map(part=>part.text).join('\n'),success:message.isError!==true,subagentDispatchId:parent});
      } else if (message.role === 'assistant') array(message.content).map(record).forEach((part,partIndex) => {
        const key=`${prefix}:message:${index}:${partIndex}`;
        if (part.type === 'text' || part.type === 'thinking') push(key,{kind:part.type==='thinking'?'thinking':'message',phase:'completed',messageId:key,
          text:String(part[part.type==='thinking'?'thinking':'text'] ?? ''),subagentDispatchId:parent});
        else if (part.type === 'toolCall') push(key,{kind:'tool',callId:`${prefix}:${part.id}`,name:String(part.name),phase:'started',input:part.arguments,subagentDispatchId:parent});
      });
    });
  });
  return events;
}
