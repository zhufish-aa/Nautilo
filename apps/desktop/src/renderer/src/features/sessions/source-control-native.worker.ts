import {prepareNativeDiff} from "./source-control-native-data";

self.onmessage=({data}:MessageEvent<{before:string;after:string;path:string}>)=>{
  postMessage(prepareNativeDiff(data.before,data.after,data.path));
};
