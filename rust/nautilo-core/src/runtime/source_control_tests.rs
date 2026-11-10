use super::*;
#[test]
fn untracked_directory_records_preserve_path_validation() {
    let state = parse_status("? doop/\0? 中文 folder/\0? file.txt\0").unwrap();
    assert_eq!(state["changes"][0]["path"], "doop");
    assert_eq!(state["changes"][0]["directory"], true);
    assert_eq!(state["changes"][2]["directory"], false);
    for record in ["? ../escape/\0", "? nested//\0", "? /outside/\0", "? .git/\0"] {
        assert!(parse_status(record).is_err(), "{record}");
    }
}
#[tokio::test]
async fn nested_repository_keeps_status_and_directory_preview_available() {
    let fixture = Fixture::new().await;
    std::fs::create_dir(fixture.root.join("nested")).unwrap();
    checked(fixture.root.join("nested").to_str().unwrap(), &["init"], None).await.unwrap();
    fixture.write("nested/keep.txt", "untouched");
    let service = SourceControl::default();
    let status = service.status(fixture.cwd()).await.unwrap();
    assert!(status["changes"].as_array().unwrap().iter().any(|item| item["path"] == "nested" && item["directory"] == true));
    let diff = service.diff(fixture.cwd(), &json!({"path":"nested","source":"worktree"})).await.unwrap();
    assert_eq!(diff["previewReason"], "directory");
    assert_eq!(std::fs::read_to_string(fixture.root.join("nested/keep.txt")).unwrap(), "untouched");
}
async fn editor_conflict(binary:bool)->Fixture{
    let fixture=Fixture::new().await;
    if binary{std::fs::write(fixture.root.join("file.txt"),[0,1,2]).unwrap();}else{fixture.write("file.txt","base\n");}fixture.write("other.txt","unchanged\n");fixture.commit().await;
    fixture.git(&["switch","-c","feature"]).await;if binary{std::fs::write(fixture.root.join("file.txt"),[0,3,4]).unwrap();}else{fixture.write("file.txt","incoming\n");}fixture.commit().await;
    fixture.git(&["switch","main"]).await;if binary{std::fs::write(fixture.root.join("file.txt"),[0,5,6]).unwrap();}else{fixture.write("file.txt","current\n");}fixture.commit().await;
    assert_ne!(git(fixture.cwd(),&["merge","feature"],None,65536).await.unwrap().code,0);fixture
}
#[tokio::test]
async fn conflict_editor_large_text_stays_editable_after_saving(){
    let fixture=Fixture::new().await;let service=SourceControl::default();let content="long line\n".repeat(180000);fixture.write("large.txt",&content);fixture.commit().await;let file=service.file(fixture.cwd(),&json!({"path":"large.txt"})).await.unwrap();assert_eq!(file["editable"],true);let edited=format!("{content}tail\n");let saved=service.save(fixture.cwd(),&json!({"path":"large.txt","fileVersion":file["token"],"content":edited})).await.unwrap();assert_eq!(saved["saved"],true);assert_eq!(saved["file"]["editable"],true);assert_eq!(saved["file"]["working"]["content"],edited);assert_eq!(fixture.git(&["show",":large.txt"]).await,content);
}
#[tokio::test]
async fn conflict_editor_preserves_bom_and_reports_saved_files_when_staging_fails(){
    let fixture=editor_conflict(false).await;let service=SourceControl::default();fixture.write("file.txt","\u{feff}current\r\n");fixture.write(".gitattributes","file.txt filter=fail\n");fixture.git(&["config","filter.fail.clean","nautilo-fixture-command-that-does-not-exist"]).await;fixture.git(&["config","filter.fail.required","true"]).await;
    let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();let saved=service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"content":"edited result\n","stage":true})).await.unwrap();assert_eq!(saved["saved"],true);assert_eq!(saved["staged"],false);assert!(saved["error"].as_str().unwrap().contains("文件已保存，但暂存失败"));assert_eq!(std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),"\u{feff}edited result\r\n");assert_eq!(fixture.git(&["ls-files","-u","--","file.txt"]).await.lines().count(),3);
}
#[tokio::test]
async fn conflict_editor_whole_version_keeps_native_symlink_mode_in_the_index(){
    let fixture=Fixture::new().await;let service=SourceControl::default();fixture.write("file.txt","base\n");fixture.commit().await;fixture.git(&["config","core.symlinks","false"]).await;
    let base=fixture.git(&["rev-parse","HEAD:file.txt"]).await.trim().to_string();let link=checked(fixture.cwd(),&["hash-object","-w","--stdin"],Some("target.txt")).await.unwrap().trim().to_string();
    let records=format!("0 {}\tfile.txt\n100644 {base} 1\tfile.txt\n100644 {base} 2\tfile.txt\n120000 {link} 3\tfile.txt\n","0".repeat(40));checked(fixture.cwd(),&["update-index","--index-info"],Some(&records)).await.unwrap();
    let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();assert_eq!(file["editable"],false);let saved=service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"resolution":"theirs","stage":true})).await.unwrap();assert_eq!(saved["staged"],true);assert!(fixture.git(&["ls-files","--stage","--","file.txt"]).await.starts_with(&format!("120000 {link} 0\t")));assert_eq!(std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),"target.txt");
}
#[tokio::test]
async fn conflict_editor_reads_native_stages_saves_draft_and_resolves_only_its_file(){
    let fixture=editor_conflict(false).await;let service=SourceControl::default();fixture.write("other.txt","keep staged\n");fixture.git(&["add","--","other.txt"]).await;
    let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();assert_eq!(file["base"]["content"],"base\n");assert_eq!(file["ours"]["content"],"current\n");assert_eq!(file["theirs"]["content"],"incoming\n");assert_eq!(file["conflict"],true);assert_eq!(file["editable"],true);
    let saved=service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"content":"manual draft\n","stage":false})).await.unwrap();assert_eq!(saved["saved"],true);assert_eq!(saved["staged"],false);assert_eq!(saved["file"]["conflict"],true);assert_eq!(fixture.git(&["ls-files","-u","--","file.txt"]).await.lines().count(),3);
    let resolved=service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":saved["file"]["token"],"content":"merged result\n","stage":true})).await.unwrap();assert_eq!(resolved["staged"],true);assert!(resolved.get("error").is_none());assert_eq!(resolved["file"]["conflict"],false);assert_eq!(fixture.git(&["show",":file.txt"]).await,"merged result\n");assert_eq!(fixture.git(&["show",":other.txt"]).await,"keep staged\n");
    change(&service,&fixture,"commit",json!({"message":"Resolved in editor"})).await;assert_eq!(fixture.git(&["rev-list","--parents","-1","HEAD"]).await.split_whitespace().count(),3);
}
#[tokio::test]
async fn conflict_editor_native_sides_keep_crlf_binary_and_clean_temporary_files(){
    let fixture=editor_conflict(false).await;let service=SourceControl::default();fixture.git(&["config","core.autocrlf","true"]).await;
    let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();let saved=service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"resolution":"theirs","stage":false})).await.unwrap();assert_eq!(std::fs::read(fixture.root.join("file.txt")).unwrap(),b"incoming\r\n");assert_eq!(saved["file"]["conflict"],true);
    let saved=service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":saved["file"]["token"],"resolution":"ours","stage":true})).await.unwrap();assert_eq!(saved["staged"],true);assert_eq!(fixture.git(&["show",":file.txt"]).await,"current\n");assert!(!std::fs::read_dir(fixture.root.join(".git")).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().starts_with(".nautilo-scm-")));
    let fixture=editor_conflict(true).await;let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();assert_eq!(file["editable"],false);assert_eq!(file["theirs"]["binary"],true);let saved=service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"resolution":"theirs","stage":true})).await.unwrap();assert_eq!(saved["staged"],true);assert_eq!(std::fs::read(fixture.root.join("file.txt")).unwrap(),vec![0,3,4]);
}
#[tokio::test]
async fn conflict_editor_rejects_external_edits_configuration_and_attributes_without_overwriting(){
    let fixture=editor_conflict(false).await;let service=SourceControl::default();let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();fixture.write("file.txt","external edit\n");
    assert!(service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"content":"overwrite","stage":true})).await.is_err());assert_eq!(std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),"external edit\n");
    let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();fixture.write(".gitattributes","file.txt text eol=crlf\n");assert!(service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"resolution":"theirs"})).await.is_err());
    let file=service.file(fixture.cwd(),&json!({"path":"file.txt"})).await.unwrap();fixture.git(&["config","core.autocrlf","true"]).await;assert!(service.save(fixture.cwd(),&json!({"path":"file.txt","fileVersion":file["token"],"content":"overwrite"})).await.is_err());assert_eq!(std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),"external edit\n");
}
#[tokio::test]
async fn commit_details_and_diffs_preserve_renames_binary_files_and_immutable_versions(){
    let fixture=Fixture::new().await;let service=SourceControl::default();
    let original=(0..30).map(|line|format!("line {line}\n")).collect::<String>();
    fixture.write("old [x] 中文.txt",&original);fixture.write("deleted.txt","removed later\n");std::fs::write(fixture.root.join("binary.dat"),[0,1,2]).unwrap();fixture.commit().await;
    let first=fixture.git(&["rev-parse","HEAD"]).await.trim().to_string();
    let initial=service.commit_details(fixture.cwd(),&json!({"hash":first})).await.unwrap();assert_eq!(initial["files"].as_array().unwrap().len(),3);assert_eq!(initial["parents"].as_array().unwrap().len(),0);
    let initial_diff=service.commit_diff(fixture.cwd(),&json!({"hash":first,"path":"old [x] 中文.txt"})).await.unwrap();assert_eq!(initial_diff["before"],"");assert_eq!(initial_diff["after"],original);
    std::fs::rename(fixture.root.join("old [x] 中文.txt"),fixture.root.join("renamed 中文.txt")).unwrap();let updated=original.replace("line 3\n","changed 3\n");fixture.write("renamed 中文.txt",&updated);
    std::fs::remove_file(fixture.root.join("deleted.txt")).unwrap();fixture.write("new.rs","fn main() {}\n");std::fs::write(fixture.root.join("binary.dat"),[0,4,5]).unwrap();fixture.git(&["add","-A"]).await;fixture.git(&["commit","-m","Subject","-m","Multiline body\nSecond line"]).await;
    let hash=fixture.git(&["rev-parse","HEAD"]).await.trim().to_string();fixture.write("renamed 中文.txt","future working edit\n");let status_before=fixture.git(&["status","--porcelain=v2","-z"]).await;
    let details=service.commit_details(fixture.cwd(),&json!({"hash":hash})).await.unwrap();assert_eq!(details["subject"],"Subject");assert!(details["body"].as_str().unwrap().contains("Second line"));let files=details["files"].as_array().unwrap();assert_eq!(files.len(),4);
    let rename=files.iter().find(|file|file["path"]=="renamed 中文.txt").unwrap();assert_eq!(rename["originalPath"],"old [x] 中文.txt");assert_eq!(rename["additions"],1);assert_eq!(rename["deletions"],1);
    assert_eq!(files.iter().find(|file|file["path"]=="binary.dat").unwrap()["binary"],true);
    let diff=service.commit_diff(fixture.cwd(),&json!({"hash":hash,"path":"renamed 中文.txt"})).await.unwrap();assert_eq!(diff["before"],original);assert_eq!(diff["after"],updated);assert_eq!(diff["commitHash"],hash);
    let deleted=service.commit_diff(fixture.cwd(),&json!({"hash":hash,"path":"deleted.txt"})).await.unwrap();assert_eq!(deleted["before"],"removed later\n");assert_eq!(deleted["after"],"");
    let binary=service.commit_diff(fixture.cwd(),&json!({"hash":hash,"path":"binary.dat"})).await.unwrap();assert_eq!(binary["binary"],true);assert!(binary.get("after").is_none());
    assert!(service.commit_details(fixture.cwd(),&json!({"hash":"--all"})).await.is_err());assert!(service.commit_diff(fixture.cwd(),&json!({"hash":hash,"path":"../escape"})).await.is_err());assert!(service.commit_diff(fixture.cwd(),&json!({"hash":hash,"path":"missing.txt"})).await.is_err());
    assert_eq!(fixture.git(&["status","--porcelain=v2","-z"]).await,status_before);assert_eq!(fixture.git(&["rev-parse","HEAD"]).await.trim(),hash);
}
#[tokio::test]
async fn merge_commit_details_compare_the_first_parent(){
    let fixture=Fixture::new().await;let service=SourceControl::default();fixture.write("main.txt","base\n");fixture.write("feature.txt","base\n");fixture.commit().await;
    fixture.git(&["switch","-c","feature"]).await;fixture.write("feature.txt","feature change\n");fixture.commit().await;fixture.git(&["switch","main"]).await;fixture.write("main.txt","main change\n");fixture.commit().await;fixture.git(&["merge","--no-edit","feature"]).await;
    let hash=fixture.git(&["rev-parse","HEAD"]).await.trim().to_string();let details=service.commit_details(fixture.cwd(),&json!({"hash":hash})).await.unwrap();assert_eq!(details["parents"].as_array().unwrap().len(),2);assert_eq!(details["files"].as_array().unwrap().len(),1);assert_eq!(details["files"][0]["path"],"feature.txt");
    let diff=service.commit_diff(fixture.cwd(),&json!({"hash":hash,"path":"feature.txt"})).await.unwrap();assert_eq!(diff["before"],"base\n");assert_eq!(diff["after"],"feature change\n");
}
#[tokio::test]
async fn code_previews_include_complete_and_separate_index_and_working_versions(){
    let fixture=Fixture::new().await;let service=SourceControl::default();let original=(0..40).map(|line|format!("line {line}\n")).collect::<String>();fixture.write("code.rs",&original);fixture.commit().await;
    let selected=original.replace("line 20\n","selected change\n");fixture.write("code.rs",&selected);change(&service,&fixture,"stage",json!({"paths":["code.rs"]})).await;
    let working=selected.replace("line 30\n","working change\n");fixture.write("code.rs",&working);
    let status=service.status(fixture.cwd()).await.unwrap();let file=status["changes"].as_array().unwrap().iter().find(|file|file["path"]=="code.rs").unwrap();assert_eq!(file["additions"],2);assert_eq!(file["deletions"],2);
    let index=service.diff(fixture.cwd(),&json!({"path":"code.rs","source":"index"})).await.unwrap();assert_eq!(index["before"],original);assert_eq!(index["after"],selected);
    let diff=service.diff(fixture.cwd(),&json!({"path":"code.rs","source":"worktree"})).await.unwrap();assert_eq!(diff["before"],selected);assert_eq!(diff["after"],working);
    fixture.write("new.rs","fn main() {}\n");let new=service.diff(fixture.cwd(),&json!({"path":"new.rs","source":"worktree"})).await.unwrap();assert_eq!(new["before"],"");assert_eq!(new["after"],"fn main() {}\n");
}
#[tokio::test]
async fn partial_adjacent_replacements_keep_unselected_line_order(){
    let fixture=Fixture::new().await;let service=SourceControl::default();fixture.write("file.txt","a\nb\nc\n");fixture.commit().await;fixture.write("file.txt","a\nB\nC\n");
    let diff=service.diff(fixture.cwd(),&json!({"path":"file.txt","source":"worktree"})).await.unwrap();let selected=diff["patch"].as_str().unwrap().lines().enumerate().filter(|(_,line)|*line=="-b"||*line=="+B").map(|(index,_)|index+1).collect::<Vec<_>>();
    change(&service,&fixture,"stage-hunks",json!({"paths":["file.txt"],"patchToken":diff["patchToken"],"lines":selected})).await;assert_eq!(fixture.git(&["show",":file.txt"]).await,"a\nB\nc\n");
    change(&service,&fixture,"stage",json!({"paths":["file.txt"]})).await;let diff=service.diff(fixture.cwd(),&json!({"path":"file.txt","source":"index"})).await.unwrap();let selected=diff["patch"].as_str().unwrap().lines().enumerate().filter(|(_,line)|*line=="-b"||*line=="+B").map(|(index,_)|index+1).collect::<Vec<_>>();
    change(&service,&fixture,"unstage-hunks",json!({"paths":["file.txt"],"patchToken":diff["patchToken"],"lines":selected})).await;assert_eq!(fixture.git(&["show",":file.txt"]).await,"a\nb\nC\n");
}
#[tokio::test]
async fn partial_hunks_and_lines_preserve_other_index_entries_and_worktree() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    let base = (1..=36)
        .map(|index| format!("line {index}\n"))
        .collect::<String>();
    fixture.write("file.txt", &base);
    fixture.write("other.txt", "base\n");
    fixture.commit().await;
    fixture.write("other.txt", "kept staged\n");
    change(&service, &fixture, "stage", json!({"paths":["other.txt"]})).await;
    let changed = base
        .replace("line 3\n", "first edit\n")
        .replace("line 30\n", "second edit\n");
    fixture.write("file.txt", &changed);
    let diff = service
        .diff(
            fixture.cwd(),
            &json!({"path":"file.txt","source":"worktree"}),
        )
        .await
        .unwrap();
    assert_eq!(diff["hunks"].as_array().unwrap().len(), 2);
    change(&service,&fixture,"stage-hunks",json!({"paths":["file.txt"],"patchToken":diff["patchToken"],"hunkIds":[diff["hunks"][1]["id"]]})).await;
    assert_eq!(
        fixture.git(&["show", ":file.txt"]).await,
        base.replace("line 30\n", "second edit\n")
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        changed
    );
    let diff = service
        .diff(fixture.cwd(), &json!({"path":"file.txt","source":"index"}))
        .await
        .unwrap();
    let lines = diff["patch"]
        .as_str()
        .unwrap()
        .lines()
        .enumerate()
        .filter(|(_, line)| *line == "-line 30" || *line == "+second edit")
        .map(|(index, _)| index + 1)
        .collect::<Vec<_>>();
    change(
        &service,
        &fixture,
        "unstage-hunks",
        json!({"paths":["file.txt"],"patchToken":diff["patchToken"],"lines":lines}),
    )
    .await;
    assert_eq!(fixture.git(&["show", ":file.txt"]).await, base);
    assert_eq!(fixture.git(&["show", ":other.txt"]).await, "kept staged\n");
}
#[tokio::test]
async fn partial_new_files_keep_native_crlf_normalization_and_can_unstage() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    fixture.git(&["config", "core.autocrlf", "true"]).await;
    fixture.write("中文 [x].txt", "one\r\ntwo\r\nthree");
    let diff = service
        .diff(
            fixture.cwd(),
            &json!({"path":"中文 [x].txt","source":"worktree"}),
        )
        .await
        .unwrap();
    let row = diff["patch"]
        .as_str()
        .unwrap()
        .lines()
        .position(|line| line == "+one")
        .unwrap()
        + 1;
    change(
        &service,
        &fixture,
        "stage-hunks",
        json!({"paths":["中文 [x].txt"],"patchToken":diff["patchToken"],"lines":[row]}),
    )
    .await;
    assert_eq!(fixture.git(&["show", ":中文 [x].txt"]).await, "one\n");
    let diff = service
        .diff(
            fixture.cwd(),
            &json!({"path":"中文 [x].txt","source":"index"}),
        )
        .await
        .unwrap();
    change(&service,&fixture,"unstage-hunks",json!({"paths":["中文 [x].txt"],"patchToken":diff["patchToken"],"hunkIds":[diff["hunks"][0]["id"]]})).await;
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("中文 [x].txt")).unwrap(),
        "one\r\ntwo\r\nthree"
    );
    assert!(fixture.git(&["ls-files"]).await.is_empty());
}
#[tokio::test]
async fn partial_patch_rejects_edits_after_preview() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    fixture.write("file.txt", "baseline\n");
    fixture.commit().await;
    fixture.write("file.txt", "reviewed\n");
    let diff = service
        .diff(
            fixture.cwd(),
            &json!({"path":"file.txt","source":"worktree"}),
        )
        .await
        .unwrap();
    fixture.write("file.txt", "new edit\n");
    let state = service.status(fixture.cwd()).await.unwrap();
    assert!(service.mutate(fixture.cwd(),&json!({"action":"stage-hunks","token":state["token"],"paths":["file.txt"],"patchToken":diff["patchToken"],"hunkIds":[diff["hunks"][0]["id"]]})).await.is_err());
    assert_eq!(fixture.git(&["show", ":file.txt"]).await, "baseline\n");
}
#[tokio::test]
async fn resolved_merge_can_finish_with_an_unchanged_index() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    fixture.write("file.txt", "base\n");
    fixture.commit().await;
    fixture.git(&["switch", "-c", "feature"]).await;
    fixture.write("file.txt", "feature\n");
    fixture.commit().await;
    fixture.git(&["switch", "main"]).await;
    fixture.write("file.txt", "main\n");
    fixture.commit().await;
    assert_eq!(
        git(fixture.cwd(), &["merge", "feature"], None, 65536)
            .await
            .unwrap()
            .code,
        1
    );
    fixture.write("file.txt", "main\n");
    let ready = change(&service, &fixture, "stage", json!({"paths":["file.txt"]})).await;
    assert_eq!(ready["changes"], json!([]));
    assert_eq!(ready["operation"], "merge");
    change(
        &service,
        &fixture,
        "commit",
        json!({"message":"Keep our content and finish merge"}),
    )
    .await;
    assert_eq!(
        fixture
            .git(&["rev-list", "--parents", "-1", "HEAD"])
            .await
            .split_whitespace()
            .count(),
        3
    );
}
#[tokio::test]
async fn history_pages_follow_the_reviewed_tip_and_search_literal_messages() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    let root = fixture.cwd();
    let empty = service.history(root, &json!({})).await.unwrap();
    assert_eq!(empty["items"], json!([]));
    fixture.write("tracked.txt", "first\n");
    fixture.commit().await;
    let base = fixture.git(&["rev-parse", "HEAD"]).await.trim().to_owned();
    fixture.git(&["commit", "--allow-empty", "-m", "Older [x].* 中文", "-m", "Search BODY here"]).await;
    let older = fixture.git(&["rev-parse", "HEAD"]).await.trim().to_owned();
    fixture.git(&["commit", "--allow-empty", "-m", "Another change"]).await;
    let tip = fixture.git(&["rev-parse", "HEAD"]).await.trim().to_owned();
    let first = service.history(root, &json!({"limit":1})).await.unwrap();
    assert_eq!(first["items"][0]["hash"], tip);
    let cursor = &first["nextCursor"];

    fixture.git(&["commit", "--allow-empty", "-m", "New while reviewing"]).await;
    let second = service.history(root, &json!({"cursor":cursor,"limit":1})).await.unwrap();
    assert_eq!(second["head"], tip);
    assert_ne!(second["currentHead"], tip);
    assert_eq!(second["items"][0]["hash"], older);
    let last = service.history(root, &json!({"cursor":second["nextCursor"],"limit":1})).await.unwrap();
    assert_eq!(last["items"][0]["hash"], base);
    assert!(last["nextCursor"].is_null());
    for query in ["[x].* 中文".to_owned(), "search body".into(), older[..10].to_uppercase()] {
        let page = service.history(root, &json!({"query":query})).await.unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["hash"], older);
    }
    assert!(service.history(root,&json!({"cursor":cursor, "query":"other"})).await.is_err());
    fixture.git(&["switch", "-c", "other", &base]).await;
    assert!(service.history(root,&json!({"cursor":cursor})).await.is_err());
    assert_eq!(service.history(root,&json!({"query":older})).await.unwrap()["items"], json!([]));
    fixture.git(&["switch", "main"]).await;
    fixture.git(&["replace", &tip, &base]).await;
    assert!(service.history(root,&json!({"cursor":cursor})).await.is_err());
}

struct Fixture {
    root: std::path::PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nautilo-scm-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let fixture = Self { root };
        fixture.git(&["init", "-b", "main"]).await;
        fixture
            .git(&["config", "user.name", "Nautilo Fixture"])
            .await;
        fixture
            .git(&["config", "user.email", "fixture@example.invalid"])
            .await;
        fixture.git(&["config", "commit.gpgsign", "false"]).await;
        fixture.git(&["config", "core.autocrlf", "false"]).await;
        fixture
    }
    fn cwd(&self) -> &str {
        self.root.to_str().unwrap()
    }
    async fn git(&self, args: &[&str]) -> String {
        checked(self.cwd(), args, None).await.unwrap()
    }
    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root.join(name), text).unwrap();
    }
    async fn commit(&self) {
        self.git(&["add", "-A"]).await;
        self.git(&["commit", "-m", "fixture baseline"]).await;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let (Ok(target), Ok(temp)) = (
            std::fs::canonicalize(&self.root),
            std::fs::canonicalize(std::env::temp_dir()),
        ) {
            if target.starts_with(&temp)
                && target
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("nautilo-scm-test-")
            {
                let _ = std::fs::remove_dir_all(target);
            }
        }
    }
}
async fn change(service: &SourceControl, fixture: &Fixture, action: &str, extra: Value) -> Value {
    let state = service.status(fixture.cwd()).await.unwrap();
    let mut input = json!({"action":action,"token":state["token"]});
    for (key, value) in extra.as_object().unwrap() {
        input[key] = value.clone();
    }
    service.mutate(fixture.cwd(), &input).await.unwrap()["status"].clone()
}
#[test]
fn porcelain_keeps_unicode_spaces_renames_and_unmerged_paths() {
    let state=parse_status("# branch.oid (initial)\0# branch.head main\0? 中文 name.txt\02 R. N... 100644 100644 100644 abc abc R100 new name.txt\0old\nname.txt\0u UU N... 100644 100644 100644 100644 a b c conflict.txt\0").unwrap();
    assert_eq!(state["changes"][0]["path"], "中文 name.txt");
    assert_eq!(state["changes"][0]["untracked"], true);
    assert_eq!(state["changes"][1]["originalPath"], "old\nname.txt");
    assert_eq!(state["changes"][2]["conflict"], true);
    assert!(parse_status("2 R. N... 1 1 1 a a R100 new\0").is_err());
    assert!(path("../outside").is_err());
}
#[tokio::test]
async fn staging_unborn_and_partial_files_commits_only_the_reviewed_index() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    fixture.write("[x].txt", "first\n");
    fixture.write("x.txt", "untouched\n");
    fixture.write("中文 name.txt", "other\n");
    let staged = change(&service, &fixture, "stage", json!({"paths":["[x].txt"]})).await;
    assert_eq!(
        staged["changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["indexStatus"] == "A")
            .count(),
        1
    );
    fixture.write("[x].txt", "later\n");
    let index = service
        .diff(fixture.cwd(), &json!({"path":"[x].txt","source":"index"}))
        .await
        .unwrap();
    assert!(index["patch"].as_str().unwrap().contains("+first"));
    change(&service, &fixture, "unstage", json!({"paths":["[x].txt"]})).await;
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("[x].txt")).unwrap(),
        "later\n"
    );
    change(&service, &fixture, "stage", json!({"paths":["[x].txt"]})).await;
    fixture.write("[x].txt", "working copy\n");
    let committed = change(
        &service,
        &fixture,
        "commit",
        json!({"message":"A quoted \"subject\"\n\nMultiline body"}),
    )
    .await;
    assert!(committed["head"].is_string());
    assert_eq!(fixture.git(&["show", "HEAD:[x].txt"]).await, "later\n");
    assert_eq!(
        fixture
            .git(&["ls-tree", "--name-only", "HEAD"])
            .await
            .trim(),
        "[x].txt"
    );
    assert!(committed["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == "[x].txt" && file["worktreeStatus"] == "M"));
}
#[tokio::test]
async fn stale_index_and_changed_file_are_rejected_before_discard() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    fixture.write("file.txt", "baseline\n");
    fixture.commit().await;
    fixture.write("file.txt", "reviewed\n");
    let state = service.status(fixture.cwd()).await.unwrap();
    let diff = service
        .diff(
            fixture.cwd(),
            &json!({"path":"file.txt","source":"worktree"}),
        )
        .await
        .unwrap();
    fixture.write("file.txt", "new edit\n");
    assert!(service.mutate(fixture.cwd(),&json!({"action":"discard","paths":["file.txt"],"token":state["token"],"fileToken":diff["fileToken"]})).await.is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "new edit\n"
    );
    let diff = service
        .diff(
            fixture.cwd(),
            &json!({"path":"file.txt","source":"worktree"}),
        )
        .await
        .unwrap();
    change(
        &service,
        &fixture,
        "discard",
        json!({"paths":["file.txt"],"fileToken":diff["fileToken"]}),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "baseline\n"
    );
    fixture.write("file.txt", "changed\n");
    let before = service.status(fixture.cwd()).await.unwrap();
    fixture.git(&["add", "file.txt"]).await;
    assert!(service
        .mutate(
            fixture.cwd(),
            &json!({"action":"commit","message":"stale commit","token":before["token"]})
        )
        .await
        .is_err());
}
#[tokio::test]
async fn linked_worktree_is_the_selected_repository_and_binary_output_is_explicit() {
    let fixture = Fixture::new().await;
    let service = SourceControl::default();
    fixture.write("file.txt", "baseline\n");
    fixture.commit().await;
    let worktree = fixture.root.join("worktree");
    fixture
        .git(&[
            "worktree",
            "add",
            "-b",
            "feature",
            worktree.to_str().unwrap(),
        ])
        .await;
    std::fs::write(worktree.join("file.txt"), "feature edit\n").unwrap();
    let state = service.status(worktree.to_str().unwrap()).await.unwrap();
    assert_eq!(state["branch"], "feature");
    assert_eq!(state["changes"][0]["path"], "file.txt");
    std::fs::write(worktree.join("binary.bin"), [1, 0, 2, 3]).unwrap();
    let diff = service
        .diff(
            worktree.to_str().unwrap(),
            &json!({"path":"binary.bin","source":"worktree"}),
        )
        .await
        .unwrap();
    assert_eq!(diff["binary"], true);
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "baseline\n"
    );
}
#[tokio::test]
async fn local_remote_publish_pull_and_dirty_branch_guards_use_native_git() {
    let fixture = Fixture::new().await;
    let holder = Fixture::new().await;
    let remote = holder.root.join("remote.git");
    fixture
        .git(&["init", "--bare", remote.to_str().unwrap()])
        .await;
    fixture.write("file.txt", "baseline\n");
    fixture.commit().await;
    fixture
        .git(&["remote", "add", "origin", remote.to_str().unwrap()])
        .await;
    let service = SourceControl::default();
    let pushed = change(&service, &fixture, "push", json!({"remote":"origin"})).await;
    assert_eq!(pushed["upstream"], "origin/main");
    assert_eq!(pushed["upstreamRemote"], "origin");
    fixture
        .git(&["remote", "add", "fork", remote.to_str().unwrap()])
        .await;
    fixture
        .git(&["config", "branch.main.pushRemote", "fork"])
        .await;
    let fork_push = change(&service, &fixture, "push", json!({})).await;
    assert_eq!(fork_push["upstreamRemote"], "origin");
    assert_eq!(fork_push["pushRemote"], "fork");
    assert_eq!(
        fixture.git(&["config", "branch.main.remote"]).await.trim(),
        "origin"
    );
    let feature = change(
        &service,
        &fixture,
        "create-branch",
        json!({"branch":"feature"}),
    )
    .await;
    assert_eq!(feature["branch"], "feature");
    change(
        &service,
        &fixture,
        "switch-branch",
        json!({"branch":"main"}),
    )
    .await;
    let other = Fixture::new().await;
    other
        .git(&["remote", "add", "origin", remote.to_str().unwrap()])
        .await;
    other.git(&["fetch", "origin"]).await;
    other.git(&["reset", "--hard", "origin/main"]).await;
    other.write("file.txt", "remote update\n");
    other.commit().await;
    other.git(&["push", "origin", "HEAD:main"]).await;
    let fetched = change(&service, &fixture, "fetch", json!({"remote":"origin"})).await;
    assert_eq!(fetched["behind"], 1);
    assert_eq!(fixture.git(&["show", "HEAD:file.txt"]).await, "baseline\n");
    change(&service, &fixture, "pull", json!({"remote":"origin"})).await;
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("file.txt")).unwrap(),
        "remote update\n"
    );
    fixture.write("file.txt", "unsaved\n");
    let state = service.status(fixture.cwd()).await.unwrap();
    assert!(service
        .mutate(
            fixture.cwd(),
            &json!({"action":"switch-branch","branch":"feature","token":state["token"]})
        )
        .await
        .is_err());
}
#[tokio::test]
async fn explicit_initialization_preserves_files_and_does_not_nest_existing_repositories() {
    let fixture = Fixture {
        root: std::env::temp_dir().join(format!("nautilo-scm-test-{}", uuid::Uuid::new_v4())),
    };
    std::fs::create_dir_all(&fixture.root).unwrap();
    fixture.write("kept.txt", "kept\n");
    let service = SourceControl::default();
    assert_eq!(
        service.status(fixture.cwd()).await.unwrap()["available"],
        false
    );
    let result = service
        .mutate(fixture.cwd(), &json!({"action":"init","token":""}))
        .await
        .unwrap();
    assert_eq!(result["status"]["available"], true);
    assert!(result["status"]["head"].is_null());
    let nested = fixture.root.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    service
        .mutate(
            nested.to_str().unwrap(),
            &json!({"action":"init","token":""}),
        )
        .await
        .unwrap();
    assert!(!nested.join(".git").exists());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("kept.txt")).unwrap(),
        "kept\n"
    );
}
