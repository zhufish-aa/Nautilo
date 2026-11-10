export type BrowserProfileInput={endpoint?:string;origins?:string[];target_id?:string;url?:string};
export type BrowserProfileResult={ok:boolean;sites?:{target_id:string;title:string;url:string;origin:string}[];imported_cookies?:number;skipped_cookies?:number;origins?:string[];authentication?:string;space_id?:string;handed_off?:boolean};
