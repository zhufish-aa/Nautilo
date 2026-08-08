# 完整MV Prompt —— 15 秒女团 Hook 版（甜酷校园 K-pop）

> 依据 `music-video-subtitle-generator` skill 流程产出。画幅 16:9（1920×1080），4 个分镜 × 3.75s。
> 人物参考：图1（红发女团成员，白衬衫+深色领带+灰色百褶裙校服造型）。
> 首帧图：`first-frame-front.png`（从图1裁出的正面干净首帧，供 I2V 使用）。

---

## [Global Aesthetic & Character Lock] 全局锚点（每个分镜 Prompt 开头都要带上）

同一位女团成员：酒红色长卷发、齐刘海、精致淡妆、白皙皮肤；白色短款短袖衬衫、深藏青领带、领口银色细链、左胸刺绣徽章、灰色高腰百褶裙配黑色双扣腰封。甜酷校园风 K-pop MV 质感：清透冷白皮色调、舞台聚光灯、浅景深、电影级调色、细腻胶片颗粒。画面比例 16:9。人物五官、发型、服装在全片严格保持一致，禁止变脸、禁止换装。

## 锁定歌词（原创，120 BPM，4/4 拍，每句约 3.75 秒 = 2 小节）

1. `Hey 聚光灯落在我肩`（Shot 1）
2. `心跳同步这鼓点`（Shot 2）
3. `转身裙摆划出弧线`（Shot 3）
4. `全世界 看我耀眼`（Shot 4，hook 重音落在"耀眼"）

## 音乐床（Master Audio 唯一基准）

120 BPM 甜酷 K-pop 舞曲：四四拍电子鼓组 + 明亮 synth lead + 弹跳 bass，副歌 hook 段能量，第 4 句结尾有一个明显 drop/重音用于收尾定格。全片只使用这一轨连续音乐，所有分镜按时间戳对齐到同一音轨。

---

## 分镜脚本

### Shot 1（0.0s – 3.75s）开场亮相

- Vocal Line: "Hey 聚光灯落在我肩"
- Typography: 无（开场保持画面干净）
- Visual & Action: 暗场中一束聚光灯亮起，红发女团成员从低头缓缓抬头直视镜头，嘴角带一点自信微笑，右手随第一拍轻打响指。背景是深色舞台，灯尘在光束中浮动。
- Camera & Motion: 中近景正面，缓慢推镜（slow push-in），景别从胸上景推到肩部以上。
- Transition Out: 最后一拍她突然向右甩头，红发扫过画面形成遮挡，镜头顺势头发表运动方向向右快速 whip pan 甩出。

### Shot 2（3.75s – 7.5s）齐舞切入

- Vocal Line: "心跳同步这鼓点"
- Typography: "心跳" 两个字随鼓点从画面下方弹入，带荧光描边，停留在左下角中景，不遮挡脸部。
- Visual & Action: 舞台全景，成员站 C 位做 K-pop 点位齐舞（胸震 + 手臂wave），身后有 2~3 个伴舞剪影，地面镜面反射灯光。动作重拍精准踩在鼓点上。
- Camera & Motion: 全景正面，低机位轻微上仰，随节拍做小幅度的 push/pull 呼吸感运镜。
- Transition Out: 她做一个手臂从左向右的大 wave，手掌在镜头前划过形成全遮挡（hand wipe），画面随手掌带出。

### Shot 3（7.5s – 11.25s）转身裙摆

- Vocal Line: "转身裙摆划出弧线"
- Typography: 无（突出动作本身）
- Visual & Action: 接上一镜头的向右动能，她在舞台另一侧亮相，做一个完整旋转，灰色百褶裙摆扬起划出弧线，红发随转身飘起，慢动作（speed ramp：转身中段放慢、首尾常速）。背景灯带拉出横向光轨。
- Camera & Motion: 中景侧面，与旋转同向的环绕运镜（orbit），强化离心动感。
- Transition Out: 旋转结束瞬间她抬眼直视镜头，鼓点重音（snare）上画面闪白一帧，切入大特写。

### Shot 4（11.25s – 15.0s）Hook 特写定格

- Vocal Line: "全世界 看我耀眼"
- Typography: "耀眼" 两个大字随 drop 重音砸入画面中央偏下，带故障 glitch 碎裂动效后稳定，不遮挡眼睛和嘴部。
- Visual & Action: 肩部以上大特写，她对着镜头唱 hook 句，口型清晰跟词，"耀眼"时微微歪头 + 眨眼（wink），眼神有光。背景虚化成舞台光斑（bokeh）。
- Camera & Motion: 大特写正面，极缓推镜，最后一个重音上画面轻微震动后定格半秒收尾。
- Transition Out: 无（片尾定格渐暗）。

---

## 转场衔接说明（三大衔接锁）

1. **动能延续**：Shot 1 甩头 whip pan 右出 → Shot 2 左入；Shot 2 手掌 wipe 右出 → Shot 3 同向环绕接入。相邻镜头运镜方向一致，杜绝方向打架。
2. **首尾帧接续**：Shot 2 与 Shot 3 为同舞台连续表演，生成 Shot 3 时用 Shot 2 的末帧做首帧（I2V），Prompt 中标注 "continuation of action"。
3. **鼓点卡切**：Shot 3 → Shot 4 的闪白硬切必须落在 snare 重音上；所有剪辑点裁在 1/4 拍网格上，严禁淡入淡出和溶解。

## H3 生成操作步骤

1. 准备一轨 15 秒 120 BPM K-pop BGM（或让 H3 在生成时按上面"音乐床"描述配声）。
2. Shot 1：用 `first-frame-front.png` 做首帧图生视频（I2VA），把全局锚点 + Shot 1 描述作为 prompt。
3. Shot 2：人物参考图用图1原图（三视图帮助保持形象一致），按 Shot 2 prompt 生成。
4. Shot 3：取 Shot 2 成片的最后一帧作为首帧，按 Shot 3 prompt 生成（continuation of action）。
5. Shot 4：人物参考图 + Shot 4 prompt 生成大特写。
6. 合成：4 段素材对齐到同一轨 Master Audio 时间轴，按转场说明在拍点上裁切拼接，全局叠一层统一调色 LUT + 轻微 35mm 胶片颗粒，掩盖跨镜头色差。

## 排除项（写进每条 prompt 的负面约束）

禁止变脸/换人，禁止改变发色和服装，禁止油亮塑料感 AI 美颜，禁止淡入淡出/溶解转场，禁止文字遮挡眼睛和嘴部，禁止多镜头色调不一致。
