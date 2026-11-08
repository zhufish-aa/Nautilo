//! Version-bound file editing. Git owns staging, filters, and conflict stages.
use super::{checked, file_token, git, hash, parse_status, path, required};
use crate::runtime::git::source_control_io::git_bytes;
use serde_json::{json, Value};
use std::{io::{Read, Write}, path::{Path, PathBuf}};
use sha2::{Digest,Sha256};

const PREVIEW:usize=4*1024*1024;
const WRITE_LIMIT:usize=PREVIEW;
#[derive(Clone)]
struct Entry { mode:String, oid:String, stage:u8 }
struct Capture { token:String, context:String, entries:Vec<Entry>, working:Value, permissions:Option<std::fs::Permissions> }

fn missing()->Value { json!({"exists":false,"binary":false,"truncated":false}) }
fn version(bytes:Vec<u8>, mode:&str, truncated:bool)->Value {
    let binary=bytes.contains(&0)||std::str::from_utf8(&bytes).is_err();
    let mut result=json!({"exists":true,"mode":mode,"binary":binary,"truncated":truncated});
    if !binary&&!truncated {result["content"]=json!(String::from_utf8(bytes).unwrap());}
    result
}
fn parent(root:&str,name:&str)->anyhow::Result<PathBuf>{
    path(name)?;let target=Path::new(root).join(name);let mut ancestor=target.parent().unwrap();let mut tail=Vec::new();
    let mut resolved=loop{match std::fs::canonicalize(ancestor){Ok(value)=>break value,Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{tail.push(ancestor.file_name().ok_or(error)?.to_os_string());ancestor=ancestor.parent().ok_or_else(||anyhow::anyhow!("文件父目录不存在"))?;},Err(error)=>return Err(error.into())}};
    for component in tail.into_iter().rev(){resolved.push(component);}
    if !resolved.starts_with(std::fs::canonicalize(root)?){anyhow::bail!("文件路径已指向工作目录之外");}
    Ok(resolved)
}
fn parse_entries(raw:&str,name:&str)->anyhow::Result<Vec<Entry>>{
    let mut result=Vec::new();
    for record in raw.split('\0').filter(|record|!record.is_empty()){
        let (metadata,entry_path)=record.split_once('\t').ok_or_else(||anyhow::anyhow!("Git 暂存记录不完整"))?;
        if entry_path!=name{continue;}let fields=metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len()!=3||!fields[1].bytes().all(|byte|byte.is_ascii_hexdigit())||!matches!(fields[1].len(),40|64){anyhow::bail!("Git 暂存记录无效");}
        let stage=fields[2].parse::<u8>()?;if stage>3{anyhow::bail!("Git 冲突阶段无效");}
        result.push(Entry{mode:fields[0].into(),oid:fields[1].into(),stage});
    }Ok(result)
}
async fn capture(root:&str,name:&str)->anyhow::Result<Capture>{
    let resolved_parent=parent(root,name)?;
    let index=checked(root,&["ls-files","--stage","-z","--",name],None).await?;
    let entries=parse_entries(&index,name)?;
    let head=git(root,&["rev-parse","--verify","--quiet","HEAD"],None,8192).await?;
    let branch=git(root,&["symbolic-ref","--quiet","HEAD"],None,8192).await?;
    let config=checked(root,&["config","--null","--list"],None).await?;
    let attributes=checked(root,&["check-attr","--all","-z","--",name],None).await?;
    let git_dir=checked(root,&["rev-parse","--absolute-git-dir"],None).await?;
    let mut context=format!("{root}\0{name}\0{index}\0{}\0{}\0{config}\0{attributes}",head.stdout,branch.stdout);
    for marker in ["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-merge/head-name","rebase-apply/head-name"]{
        let file=Path::new(git_dir.trim()).join(marker);
        match std::fs::File::open(file){Ok(file)=>{let mut bytes=Vec::new();file.take(65537).read_to_end(&mut bytes)?;if bytes.len()>65536{anyhow::bail!("Git 操作状态过大");}context.push_str(&format!("\0{marker}:{}",hash(bytes)));},Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{},Err(error)=>return Err(error.into())}
    }
    let target=Path::new(root).join(name);
    let mut permissions=None;
    let (working,identity)=match std::fs::symlink_metadata(&target){
        Ok(metadata)if metadata.file_type().is_symlink()=>{
            let value=std::fs::read_link(&target)?.to_string_lossy().into_owned();let identity=format!("link:{value}");(version(value.into_bytes(),"120000",false),identity)
        },
        Ok(metadata)if metadata.is_file()=>{
            let mut bytes=Vec::new();let mut input=std::fs::File::open(&target)?;let mut digest=Sha256::new();let mut buffer=vec![0;65536];let mut size=0usize;
            loop{let count=input.read(&mut buffer)?;if count==0{break;}digest.update(&buffer[..count]);let keep=(PREVIEW.saturating_sub(bytes.len())).min(count);bytes.extend_from_slice(&buffer[..keep]);size=size.saturating_add(count);}let truncated=size>PREVIEW;
            #[cfg(unix)]let mode={use std::os::unix::fs::PermissionsExt;if metadata.permissions().mode()&0o111!=0{"100755"}else{"100644"}};
            #[cfg(not(unix))]let mode=entries.iter().find(|entry|entry.stage==0||entry.stage==2).map(|entry|entry.mode.as_str()).filter(|mode|*mode=="100755").unwrap_or("100644");
            let identity=format!("file:{:x}:{}:{mode}",digest.finalize(),metadata.permissions().readonly());permissions=Some(metadata.permissions());(version(bytes,mode,truncated),identity)
        },
        Ok(metadata)if metadata.is_dir()&&entries.iter().any(|entry|entry.mode=="160000")=>(json!({"exists":true,"binary":true,"truncated":false,"mode":"160000"}),"submodule".to_string()),
        Ok(_)=>anyhow::bail!("此项目不是可编辑文件"),
        Err(error)if error.kind()==std::io::ErrorKind::NotFound=>(missing(),"missing".to_string()),
        Err(error)=>return Err(error.into()),
    };
    let token=hash(format!("{context}\0{}\0{identity}",resolved_parent.to_string_lossy()));
    Ok(Capture{token,context:hash(context),entries,working,permissions})
}
async fn entry_version(root:&str,entry:Option<&Entry>)->anyhow::Result<Value>{
    let Some(entry)=entry else{return Ok(missing());};
    if entry.mode=="160000"{return Ok(json!({"exists":true,"content":entry.oid,"binary":false,"truncated":false,"mode":entry.mode}));}
    let result=Box::pin(git_bytes(root,&["cat-file","blob",&entry.oid],None,PREVIEW)).await?;
    if result.code!=0{anyhow::bail!("{}",result.stderr);}Ok(version(result.stdout,&entry.mode,result.truncated))
}
pub(super) async fn read(root:&str,name:&str,allow_missing:bool)->anyhow::Result<Value>{
    let captured=capture(root,name).await?;
    if captured.entries.is_empty()&&!allow_missing{
        let raw=checked(root,&["status","--porcelain=v2","-z","--untracked-files=all","--",name],None).await?;
        if !parse_status(&raw)?["changes"].as_array().unwrap().iter().any(|file|file["path"]==name){anyhow::bail!("请选择一个 Git 文件");}
    }
    let mut result=json!({"rootPath":root,"path":name,"token":captured.token,"conflict":captured.entries.iter().any(|entry|entry.stage!=0),"working":captured.working});
    for(key,stage)in [("base",1),("ours",2),("theirs",3),("index",0)]{result[key]=entry_version(root,captured.entries.iter().find(|entry|entry.stage==stage)).await?;}
    result["editable"]=json!(result["working"]["binary"]!=true&&result["working"]["truncated"]!=true&&!captured.entries.iter().any(|entry|!matches!(entry.mode.as_str(),"100644"|"100755"))&&result["working"]["mode"]!="120000"&&result["working"]["mode"]!="160000");
    if capture(root,name).await?.token!=captured.token{anyhow::bail!("文件内容已改变，请重新读取；当前编辑尚未保存。");}
    Ok(result)
}
struct TempFile(PathBuf);
impl Drop for TempFile{fn drop(&mut self){
    #[cfg(windows)]if let Ok(metadata)=std::fs::symlink_metadata(&self.0){if metadata.is_file()&&metadata.permissions().readonly(){let mut permissions=metadata.permissions();permissions.set_readonly(false);let _=std::fs::set_permissions(&self.0,permissions);}}
    let _=std::fs::remove_file(&self.0);
}}
struct Checkout{root:PathBuf,prefix:PathBuf,target:PathBuf}
impl Drop for Checkout{fn drop(&mut self){
    if !self.prefix.starts_with(&self.root)||!self.prefix.file_name().is_some_and(|name|name.to_string_lossy().starts_with(".nautilo-scm-")){return;}
    let _=std::fs::remove_file(&self.target);let mut directory=self.target.parent();
    while let Some(current)=directory{if !current.starts_with(&self.prefix){break;}let _=std::fs::remove_dir(current);if current==self.prefix{break;}directory=current.parent();}
}}
fn preserve_text(content:&str,working:&Value)->String{
    let previous=working["content"].as_str().unwrap_or("");let mut result=content.to_string();
    if previous.contains("\r\n")&&!previous.replace("\r\n","").contains('\n'){result=result.replace("\r\n","\n").replace('\n',"\r\n");}
    if previous.starts_with('\u{feff}')&&!result.starts_with('\u{feff}'){result.insert(0,'\u{feff}');}result
}
pub(super) async fn write(root:&str,input:&Value)->anyhow::Result<(bool,Option<String>)>{
    let name=required(input,"path")?;path(name)?;let expected=required(input,"fileVersion")?;
    let file=read(root,name,false).await?;if file["token"]!=expected{anyhow::bail!("文件内容、Git 版本或配置已改变，请刷新后重新保存。草稿仍保留。");}
    if ["base","ours","theirs","index"].iter().any(|key|file[key]["mode"]=="160000"){anyhow::bail!("子模块冲突请在原生终端处理，不能作为普通文件保存。");}
    let resolution=input["resolution"].as_str().unwrap_or("edited");
    if resolution!="edited"&&file["conflict"]!=true{anyhow::bail!("此文件已不再处于冲突状态，请刷新后重试。");}
    let target=Path::new(root).join(name);
    let captured=capture(root,name).await?;if captured.token!=expected{anyhow::bail!("文件已改变，请刷新后重试。草稿仍保留。");}
    let expected_working;
    let stage=match resolution{"ours"=>Some(2),"theirs"=>Some(3),"base"=>Some(1),"delete"|"edited"=>None,_=>anyhow::bail!("未知合并结果")};
    let selected=stage.and_then(|stage|captured.entries.iter().find(|entry|entry.stage==stage)).cloned();
    if resolution=="edited"{
        if file["editable"]!=true{anyhow::bail!("此文件无法作为文本编辑；请采用完整版本。");}
        let content=input["content"].as_str().ok_or_else(||anyhow::anyhow!("缺少文件内容"))?;
        if content.len()>WRITE_LIMIT||content.contains('\0'){anyhow::bail!("编辑内容过大或包含二进制数据");}
        let content=preserve_text(content,&file["working"]);if content.len()>WRITE_LIMIT{anyhow::bail!("编辑内容过大");}expected_working=hash(content.as_bytes());let intended_parent=parent(root,name)?;std::fs::create_dir_all(target.parent().unwrap())?;
        if std::fs::canonicalize(target.parent().unwrap())?!=intended_parent{anyhow::bail!("文件父目录已改变，请重试");}
        let temp=TempFile(target.parent().unwrap().join(format!(".nautilo-save-{}.tmp",uuid::Uuid::new_v4())));
        let mut output=std::fs::OpenOptions::new().write(true).create_new(true).open(&temp.0)?;output.write_all(content.as_bytes())?;output.sync_all()?;drop(output);
        if let Some(permissions)=captured.permissions{std::fs::set_permissions(&temp.0,permissions)?;}
        if capture(root,name).await?.token!=expected{anyhow::bail!("文件内容已改变，尚未覆盖文件。请刷新后重试。");}
        std::fs::rename(&temp.0,&target)?;
    }else if let Some(entry)=selected.as_ref(){
        let git_dir=checked(root,&["rev-parse","--absolute-git-dir"],None).await?;let root_path=std::fs::canonicalize(git_dir.trim())?;let prefix=root_path.join(format!(".nautilo-scm-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&prefix)?;
        let prepared=Checkout{root:root_path,prefix:prefix.clone(),target:prefix.join(name)};
        let native=prefix.to_string_lossy();let native=if let Some(unc)=native.strip_prefix("\\\\?\\UNC\\"){format!("\\\\{unc}")}else{native.strip_prefix("\\\\?\\").unwrap_or(&native).to_string()};
        let prefix_arg=format!("--prefix={}/",native.replace('\\',"/"));
        checked(root,&["checkout-index",&format!("--stage={}",entry.stage),"--force",&prefix_arg,"--stdin","-z"],Some(&format!("{name}\0"))).await?;
        expected_working=file_token(&prefix.to_string_lossy(),name).await?;
        let intended_parent=parent(root,name)?;std::fs::create_dir_all(target.parent().unwrap())?;
        if std::fs::canonicalize(target.parent().unwrap())?!=intended_parent||capture(root,name).await?.token!=expected{anyhow::bail!("文件或 Git 版本已改变，尚未覆盖文件。请刷新后重试。");}
        std::fs::rename(&prepared.target,&target)?;
    }else{
        expected_working=hash("missing");
        if capture(root,name).await?.token!=expected{anyhow::bail!("文件已改变，尚未删除。请刷新后重试。");}
        match std::fs::remove_file(&target){Ok(())=>{},Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{},Err(error)=>return Err(error.into())}
    }
    let validated=async{let after=capture(root,name).await?;Ok::<_,anyhow::Error>(after.context==captured.context&&file_token(root,name).await?==expected_working)}.await;
    match validated{Ok(true)=>{},Ok(false)=>return Ok((false,Some("文件已写入，但文件或 Git 状态又被其他程序修改；尚未暂存，请刷新并核对。".into()))),Err(error)=>return Ok((false,Some(format!("文件已保存，但核对状态失败：{error}"))))};
    if input["stage"]==true{
        let staged=if let Some(entry)=selected{checked(root,&["update-index","--add","--cacheinfo",&entry.mode,&entry.oid,name],None).await}else{checked(root,&["add","-A","--pathspec-from-file=-","--pathspec-file-nul"],Some(&format!("{name}\0"))).await};
        return Ok(match staged{Ok(_)=>(true,None),Err(error)=>(false,Some(format!("文件已保存，但暂存失败：{error}")))});
    }Ok((false,None))
}
