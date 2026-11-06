use agenthub_plugin_sdk::ProviderPlugin;
use serde_json::{json,Value};
use std::sync::{Arc,Mutex};
struct BackgroundChannel {events:Mutex<Vec<Value>>,questions:Mutex<Vec<Value>>,leases:Mutex<Vec<bool>>}
impl agenthub_plugin_sdk::DaemonChannel for BackgroundChannel {
    fn hold_session(&self,_:&str,active:bool)->std::pin::Pin<Box<dyn std::future::Future<Output=()>+Send+'_>> {self.leases.lock().unwrap().push(active);Box::pin(async{})}
    fn publish_session(&self,_:&str,event:Value)->std::pin::Pin<Box<dyn std::future::Future<Output=()>+Send+'_>> {self.events.lock().unwrap().push(event);Box::pin(async{})}
    fn ask_session(&self,_:&str,input:Value)->std::pin::Pin<Box<dyn std::future::Future<Output=Value>+Send+'_>> {self.questions.lock().unwrap().push(input);Box::pin(async{json!({"outcome":"selected","optionId":"confirm"})})}
    fn ask(&self,_:&str,_:Value)->std::pin::Pin<Box<dyn std::future::Future<Output=Value>+Send+'_>> {Box::pin(async{json!({"outcome":"cancelled"})})}
    fn call_tool(&self,_:&str,_:&str,_:Value)->std::pin::Pin<Box<dyn std::future::Future<Output=Value>+Send+'_>> {Box::pin(async{json!({"success":false})})}
}
async fn collect(mut events:tokio::sync::mpsc::UnboundedReceiver<Value>)->(String,i64){
    tokio::time::timeout(std::time::Duration::from_secs(8),async move {
        let mut text=String::new();while let Some(event)=events.recv().await {
            if event["kind"]=="message" && event["text"].as_str().is_some_and(|text|!text.is_empty()) {text=event["text"].as_str().unwrap().to_string();}
            if event["kind"]=="error" {eprintln!("{}",event["message"]);}
            if event["kind"]=="exit" {return(text,event["exitCode"].as_i64().unwrap_or(-1));}
        }(text,-1)
    }).await.expect("plugin turn must terminate")
}
pub async fn exercise(plugin:&dyn ProviderPlugin,provider:&str){
    let fixture=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/native-session.mjs");
    let env:std::collections::HashMap<String,String>=std::env::vars().filter(|(key,_)|["path","systemroot","windir","temp","tmp","comspec"].contains(&key.to_lowercase().as_str())).collect();
    let mut request=json!({"instance":{"executable":"node","baseArgs":[fixture,provider]},"env":env,
        "cwd":std::env::temp_dir(),"localSessionId":"fixture-local","prompt":"first","timeoutMs":4000});
    let(first,code)=collect(plugin.start("first",request.clone(),None).await.unwrap()).await;assert_eq!(code,0,"{first}");
    request["prompt"]=json!("second");
    let(second,code)=collect(plugin.start("second",request.clone(),Some("fixture-session".into())).await.unwrap()).await;assert_eq!(code,0,"{second}");
    assert_eq!(first.split(':').next(),second.split(':').next(),"runtime restarted");assert!(second.contains(":2:second"),"{second}");
    if ["pi","omp"].contains(&provider) {
        request["prompt"]=json!("/native-status");let(text,code)=collect(plugin.start("command",request.clone(),Some("fixture-session".into())).await.unwrap()).await;
        assert_eq!(code,0);assert!(text.contains("native-command-output"));
    }
    request["prompt"]=json!("hang");request["timeoutMs"]=json!(80);
    let(_,code)=collect(plugin.start("timeout",request.clone(),Some("fixture-session".into())).await.unwrap()).await;assert_ne!(code,0);
    request["prompt"]=json!("recovered");request["timeoutMs"]=json!(4000);
    let(recovered,code)=collect(plugin.start("recovery",request.clone(),Some("fixture-session".into())).await.unwrap()).await;
    assert_eq!(code,0);assert!(recovered.contains(":1:recovered"),"{recovered}");
    request["prompt"]=json!("hang");
    let events=plugin.start("cancel",request,Some("fixture-session".into())).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(70)).await;plugin.cancel("cancel").await;
    assert_ne!(collect(events).await.1,0);
    let channel=Arc::new(BackgroundChannel{events:Mutex::new(vec![]),questions:Mutex::new(vec![]),leases:Mutex::new(vec![])});
    plugin.set_daemon_channel(channel.clone());
    let request=json!({"instance":{"executable":"node","baseArgs":[fixture,provider]},"env":env,
        "cwd":std::env::temp_dir(),"localSessionId":"fixture-background","sessionBindingId":"background-binding","prompt":"background","timeoutMs":4000});
    let (_,code)=collect(plugin.start("background",request.clone(),None).await.unwrap()).await;assert_eq!(code,0);
    tokio::time::timeout(std::time::Duration::from_secs(2),async {
        loop {
            let ready=channel.events.lock().unwrap().iter().any(|event|event["kind"]=="extension_ui" && event["text"]=="background-confirmed");
            if ready {break;}tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }).await.unwrap_or_else(|_|panic!("background events and extension confirmation must arrive before another turn; events={:?}, questions={:?}, leases={:?}",channel.events.lock().unwrap(),channel.questions.lock().unwrap(),channel.leases.lock().unwrap()));
    let background=channel.events.lock().unwrap().clone();
    assert!(background.iter().any(|event|event["kind"]=="tool" && event["phase"]=="started" && event["callId"]=="background-call"),"same-read tail was discarded: {background:?}");
    assert!(background.iter().any(|event|event["kind"]=="tool" && event["phase"]=="completed" && event["callId"]=="background-call"));
    assert_eq!(channel.questions.lock().unwrap().len(),1);
    assert_eq!(*channel.leases.lock().unwrap(),vec![true]);
    let mut next=request.clone();next["prompt"]=json!("after-background");next["sessionBindingId"]=json!("next-binding");
    let (reply,code)=collect(plugin.start("after-background",next,Some("fixture-session".into())).await.unwrap()).await;
    assert_eq!(code,0);assert!(reply.contains(":2:after-background"));
    plugin.dispose().await;
}
