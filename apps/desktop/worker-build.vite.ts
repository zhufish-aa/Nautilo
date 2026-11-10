import type {Plugin} from "vite";

let previousBuild:Promise<void>=Promise.resolve();

/** Vite 5 bundles every language worker separately. Bound their combined AST
 * memory on desktop machines; runtime workers still execute independently. */
export function serialWorkerBuilds(bundleChain:string[]=[]):Plugin{
  let unlock:(()=>void)|undefined;
  const release=():void=>{unlock?.();unlock=undefined;};
  return{
    name:"nautilo-serial-worker-builds",
    apply:"build",
    async buildStart(){
      // A nested worker is part of its parent's turn, so never wait on it.
      if(bundleChain.length>1)return;
      const ready=previousBuild;
      previousBuild=new Promise<void>(resolve=>{unlock=resolve;});
      await ready;
    },
    buildEnd(error){if(error)release();},
    closeBundle(){release();}
  };
}
