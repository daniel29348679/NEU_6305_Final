# QR Photo Transfer Demo

用兩台電腦的前置攝影機，透過螢幕上的 QR code 來傳送照片。  
一台是 Sender，一台是 Receiver。Sender 會把照片壓縮、切片、轉成多個 QR frame；Receiver 收到後會回傳 ACK QR，並在缺片時要求重傳。

## 功能

- React + Vite 單頁應用
- Sender / Receiver 雙模式
- 雙方都使用前置攝影機掃描對方螢幕
- 滑動視窗傳輸
- 缺片重傳
- ACK 回傳
- 全螢幕模式
- 中央大型掃碼框
- 相機預覽左右鏡像
- 速度模式切換
- 資料 QR 預先快取
- 類 TCP 動態視窗控制

## 安裝

需要 Node.js 18 以上。

```bash
npm install
```

## 本機啟動

```bash
npm run dev
```

預設會跑在：

```text
http://localhost:5173
```

## 對外 demo

這個專案已經把 Vite 設定成：

- `host: 0.0.0.0`
- `port: 5173`
- `allowedHosts: true`

所以可以直接搭配 ngrok：

```bash
npm run dev
ngrok http 5173
```

再把 ngrok 產生的 `https://...ngrok-free.app` 網址給對方。

## Demo 流程

1. 兩台電腦都開同一個網址。
2. 兩邊都允許相機權限。
3. 一台切到 `Sender`，另一台切到 `Receiver`。
4. 兩邊先選一樣的速度模式。
5. Sender 選照片。
6. 兩台都切全螢幕。
7. 把 Sender 的資料 QR 對準 Receiver 前鏡頭。
8. 把 Receiver 的 ACK QR 對準 Sender 前鏡頭。
9. 等待 Receiver 重組出圖片。

## 速度模式

### Fast

- 最大速度
- 壓縮更強
- QR 容錯較低
- 比較適合亮度高、距離穩、對焦快的 demo 環境

### Balanced

- 折衷模式
- 速度和穩定性比較平均

### Reliable

- 速度較慢
- QR 容錯較高
- 比較適合環境光差、鏡頭品質普通、或掃描不穩時

## 提速建議

- 兩台螢幕亮度都開高
- 使用全螢幕
- 保持 20 到 40 公分距離
- 盡量讓 QR 填滿中央掃碼框
- 若 Fast 不穩，改用 Balanced 或 Reliable
- 圖片盡量不要太大、太細節

## 傳輸機制

- Sender 先送 `meta`
- Receiver 回傳 ACK
- Sender 用滑動視窗連續送 chunk frames
- Sender 會依 ACK 狀況自動增減窗口大小
- Receiver 回傳最高連續收到的 frame 與缺片列表
- Sender 優先補送缺片
- 所有 chunk 完成後，Sender 再送 `done`

這不是標準 TCP，而是模仿 TCP 思想的簡化版 QR 傳輸協定。

## 專案指令

```bash
npm run dev
npm run build
npm run preview
```

## 注意

- 這是 demo 專案，不是正式商用品質的高吞吐傳輸系統。
- `allowedHosts: true` 是為了方便 ngrok demo，正式部署不建議這樣開。
- 瀏覽器的全螢幕通常需要使用者手勢；如果自動切換失敗，手動按一次 `Fullscreen` 即可。
