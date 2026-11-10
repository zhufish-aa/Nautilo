type RecordValue = Record<string, any>;
export function isBrowserTool(name: string) { return /(?:^|[_.:/-])browser_(run|eval|assert|wait|read|tabs|state|screenshot|scroll|session|files|dialog|cdp|fetch|paste|events)(?:$|_for_control$)/i.test(name); }
function object(value: unknown): RecordValue | undefined {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return undefined; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as RecordValue;
  return item.structuredContent ? object(item.structuredContent) : item.content?.find?.((part:any) => part.type === "text") ? object(item.content.find((part:any)=>part.type === "text").text) : item;
}
const verbs: Record<string,[string,string]> = {
  open:["打开网页","Open page"],goto:["打开网页","Open page"],read:["读取网页","Read page"],
  click:["点击元素","Click element"],dblclick:["双击元素","Double-click"],fill:["填写表单","Fill field"],press:["键盘输入","Press key"],
  scroll:["滚动网页","Scroll page"],scroll_into_view:["定位元素","Locate element"],scroll_to_text:["定位文本","Find text"],
  wait:["等待页面","Wait for page"],wait_for_control:["等待交还控制","Wait for control"],assert:["验证页面","Verify page"],eval:["执行网页脚本","Evaluate page"],
  screenshot:["网页截图","Capture page"],tabs:["管理标签","Manage tabs"],session:["管理浏览空间","Manage browser space"],
  files:["传输文件","Transfer files"],dialog:["处理网页对话框","Handle dialog"],cdp:["浏览器协议操作","Browser protocol"],
  fetch:["请求网页数据","Fetch page data"],paste:["粘贴内容","Paste content"],events:["查看网页事件","Inspect page events"],
  back:["返回上一页","Go back"],forward:["前进一页","Go forward"],reload:["重新加载","Reload page"],hover:["悬停元素","Hover element"],select:["选择选项","Select option"],drag:["拖动元素","Drag element"],state:["检查网页状态","Inspect page"],
};
export function browserStepLabel(step: RecordValue, zh: boolean) {
  const verb = verbs[step.action]?.[zh?0:1] ?? (zh?"浏览器操作":"Browser action");
  const target = step.target ?? {};
  let subject: string = step.label || step.description || target.name || target.text || (step.action === "press" ? step.key : undefined) || "";
  if (step.url) { try { subject = new URL(step.url).hostname; } catch { subject = step.url; } }
  if (!subject && step.expect?.popup) subject = zh?"新标签":"New tab";
  if (!subject && step.expect?.eval) subject = zh?"网页内部状态":"Page state";
  return verb + (subject ? " · " + String(subject).replace(/\s+/g," ").slice(0,90) : "");
}
export function browserActivity(name: string, input?: string, output?: string) {
  const raw = object(input) ?? {}, args = raw.arguments ?? raw;
  const envelope = object(output);
  const result = envelope?.version === 2 ? {...envelope.data,...envelope} : envelope;
  const action = /browser_(\w+)$/i.exec(name)?.[1] ?? "run";
  const requested = Array.isArray(args.steps) ? args.steps : [{...args,action}];
  const steps = requested.map((step:RecordValue,index:number) => ({...step,...result?.steps?.[index]}));
  return {args,result,steps};
}
