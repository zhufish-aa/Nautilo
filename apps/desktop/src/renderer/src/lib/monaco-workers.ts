// Inline worker payloads keep packaged file:// windows working. Load each
// language constructor only when Monaco requests it, keeping TS out of Rust diffs.
export async function createMonacoWorker(_workerId:string,label:string):Promise<Worker>{
  if(label==="typescript"||label==="javascript"){
    const {default:LanguageWorker}=await import("monaco-editor/language/typescript/ts.worker.js?worker&inline");
    return new LanguageWorker();
  }
  if(label==="json"||label==="jsonc"){
    const {default:LanguageWorker}=await import("monaco-editor/language/json/json.worker.js?worker&inline");
    return new LanguageWorker();
  }
  if(label==="css"||label==="scss"||label==="less"){
    const {default:LanguageWorker}=await import("monaco-editor/language/css/css.worker.js?worker&inline");
    return new LanguageWorker();
  }
  if(label==="html"||label==="handlebars"||label==="razor"){
    const {default:LanguageWorker}=await import("monaco-editor/language/html/html.worker.js?worker&inline");
    return new LanguageWorker();
  }
  const {default:EditorWorker}=await import("monaco-editor/editor/editor.worker.js?worker&inline");
  return new EditorWorker();
}

self.MonacoEnvironment={...self.MonacoEnvironment,getWorker:createMonacoWorker};
