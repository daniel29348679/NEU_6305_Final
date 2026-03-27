import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";

const SCAN_INTERVAL_MS = 140;
const DUPLICATE_WINDOW_MS = 280;
const GUIDE_RATIO = 0.76;

const SPEED_PROFILES = {
  fast: {
    id: "fast",
    label: "Fast",
    chunkSize: 420,
    maxImageSide: 960,
    imageQuality: 0.6,
    windowSize: 6,
    minWindowSize: 2,
    maxWindowSize: 10,
    frameCycleMs: 180,
    retransmitAfterMs: 1600,
    ackMissingLimit: 12,
    qrErrorCorrection: "L",
    dataQrWidth: 460,
    ackQrWidth: 300,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    chunkSize: 320,
    maxImageSide: 1120,
    imageQuality: 0.68,
    windowSize: 4,
    minWindowSize: 2,
    maxWindowSize: 8,
    frameCycleMs: 230,
    retransmitAfterMs: 1900,
    ackMissingLimit: 10,
    qrErrorCorrection: "M",
    dataQrWidth: 440,
    ackQrWidth: 320,
  },
  reliable: {
    id: "reliable",
    label: "Reliable",
    chunkSize: 240,
    maxImageSide: 1280,
    imageQuality: 0.76,
    windowSize: 3,
    minWindowSize: 1,
    maxWindowSize: 6,
    frameCycleMs: 300,
    retransmitAfterMs: 2400,
    ackMissingLimit: 8,
    qrErrorCorrection: "Q",
    dataQrWidth: 420,
    ackQrWidth: 340,
  },
};

function makeSessionId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function splitText(text, chunkSize) {
  const parts = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    parts.push(text.slice(index, index + chunkSize));
  }
  return parts;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function nowMs() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function requestAppFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // Fullscreen requires a user gesture in some browsers.
  }
}

async function imageFileToPayload(file, profile) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, profile.maxImageSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, "image/webp", profile.imageQuality);
  });

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Image read failed."));
    reader.readAsDataURL(blob);
  });

  return {
    fileName: file.name,
    originalType: file.type || "image/*",
    encodedType: "image/webp",
    width,
    height,
    dataUrl,
  };
}

async function frameToQrDataUrl(frame, profile, widthOverride) {
  const payload = JSON.stringify(frame);
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: profile.qrErrorCorrection,
    margin: 1,
    scale: 8,
    width: widthOverride || profile.dataQrWidth,
    color: {
      dark: "#08131c",
      light: "#f5efe2",
    },
  });
}

async function buildQrCache(frames, profile) {
  const cache = {};
  await Promise.all(
    frames.map(async (frame) => {
      cache[frame.frameId] = await frameToQrDataUrl(frame, profile, profile.dataQrWidth);
    }),
  );
  return cache;
}

function buildAckFrame(sessionId, receivedFrames, chunkCount, ackMissingLimit, done = false) {
  let highestContiguous = 0;
  while (receivedFrames.has(highestContiguous + 1)) {
    highestContiguous += 1;
  }

  const missingFrameIds = [];
  for (let frameId = highestContiguous + 1; frameId <= chunkCount; frameId += 1) {
    if (!receivedFrames.has(frameId)) {
      missingFrameIds.push(frameId);
    }
    if (missingFrameIds.length >= ackMissingLimit) {
      break;
    }
  }

  return {
    kind: "ack",
    sessionId,
    highestContiguous,
    missingFrameIds,
    receivedCount: Math.max(0, receivedFrames.size - 1),
    done,
    sentAt: nowMs(),
  };
}

function useQrScanner(onMessage) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [cameraLabel, setCameraLabel] = useState("");

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let stopped = false;
    let scanTimer = null;
    let rafId = null;
    let lastRaw = "";
    let lastSeenAt = 0;

    async function start() {
      try {
        setStatus("requesting");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });

        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const [track] = stream.getVideoTracks();
        setCameraLabel(track?.label || "front camera");

        const video = videoRef.current;
        if (!video) {
          return;
        }

        video.srcObject = stream;
        await video.play();
        setStatus("ready");

        const scan = () => {
          if (stopped) {
            return;
          }

          const canvas = canvasRef.current;
          const context = canvas?.getContext("2d", { willReadFrequently: true });
          if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA && canvas && context) {
            const sourceWidth = video.videoWidth;
            const sourceHeight = video.videoHeight;
            const side = Math.floor(Math.min(sourceWidth, sourceHeight) * GUIDE_RATIO);
            const sx = Math.floor((sourceWidth - side) / 2);
            const sy = Math.floor((sourceHeight - side) / 2);

            canvas.width = side;
            canvas.height = side;
            context.drawImage(video, sx, sy, side, side, 0, 0, side, side);

            const imageData = context.getImageData(0, 0, side, side);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: "attemptBoth",
            });

            if (code?.data) {
              const now = nowMs();
              const duplicate = code.data === lastRaw && now - lastSeenAt < DUPLICATE_WINDOW_MS;
              if (!duplicate) {
                lastRaw = code.data;
                lastSeenAt = now;
                onMessageRef.current(code.data);
              }
            }
          }

          scanTimer = window.setTimeout(() => {
            rafId = window.requestAnimationFrame(scan);
          }, SCAN_INTERVAL_MS);
        };

        scan();
      } catch (scanError) {
        setError(scanError instanceof Error ? scanError.message : "Camera unavailable.");
        setStatus("error");
      }
    }

    start();

    return () => {
      stopped = true;
      if (scanTimer) {
        window.clearTimeout(scanTimer);
      }
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  return { videoRef, canvasRef, status, error, cameraLabel };
}

function SpeedSelector({ profileId, onChange }) {
  return (
    <div className="speed-selector">
      {Object.values(SPEED_PROFILES).map((profile) => (
        <button
          key={profile.id}
          className={profileId === profile.id ? "mode-button active" : "mode-button"}
          onClick={() => onChange(profile.id)}
        >
          {profile.label}
        </button>
      ))}
    </div>
  );
}

function CameraPanel({ scanner, title, helper }) {
  return (
    <section className="panel camera-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className={`badge badge-${scanner.status}`}>{scanner.status}</span>
      </div>
      <p className="muted">{helper}</p>
      <div className="camera-stage">
        <video ref={scanner.videoRef} playsInline muted className="camera-video" />
        <div className="scan-guide">
          <div className="scan-corners top-left" />
          <div className="scan-corners top-right" />
          <div className="scan-corners bottom-left" />
          <div className="scan-corners bottom-right" />
        </div>
      </div>
      <canvas ref={scanner.canvasRef} className="hidden-canvas" />
      <p className="tiny">
        {scanner.error
          ? `Camera error: ${scanner.error}`
          : scanner.cameraLabel
            ? `Using: ${scanner.cameraLabel}`
            : "Waiting for camera permission"}
      </p>
    </section>
  );
}

function adjustCongestionWindow(transmission, payload) {
  const previousAck = transmission.highestContiguous;
  const nextAck = Math.max(previousAck, payload.highestContiguous ?? 0);
  const missingCount = (payload.missingFrameIds || []).length;
  const ackAdvanced = nextAck > previousAck;
  const sawLoss = missingCount > 0;

  if (sawLoss) {
    transmission.ssthresh = Math.max(
      transmission.profile.minWindowSize,
      Math.floor(transmission.windowSize / 2),
    );
    transmission.windowSize = Math.max(
      transmission.profile.minWindowSize,
      Math.floor(transmission.windowSize / 2),
    );
    transmission.congestionState = "recovery";
    transmission.lossEvents += 1;
    return;
  }

  if (!ackAdvanced) {
    return;
  }

  if (transmission.windowSize < transmission.ssthresh) {
    transmission.windowSize = Math.min(
      transmission.profile.maxWindowSize,
      transmission.windowSize + 1,
    );
    transmission.congestionState = "slow-start";
    return;
  }

  transmission.ackAccumulator += 1;
  if (transmission.ackAccumulator >= transmission.windowSize) {
    transmission.windowSize = Math.min(
      transmission.profile.maxWindowSize,
      transmission.windowSize + 1,
    );
    transmission.ackAccumulator = 0;
  }
  transmission.congestionState = "congestion-avoidance";
}

function SenderView({ onFullscreen, profileId, onProfileChange }) {
  const profile = SPEED_PROFILES[profileId];
  const [prepared, setPrepared] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [log, setLog] = useState([]);
  const [receiverAck, setReceiverAck] = useState(null);
  const [currentFrameId, setCurrentFrameId] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [tick, setTick] = useState(0);
  const [doneQr, setDoneQr] = useState("");
  const transmissionRef = useRef(null);

  const pushLog = (line) => {
    setLog((prev) => [line, ...prev].slice(0, 12));
  };

  const scanner = useQrScanner((raw) => {
    const payload = safeJsonParse(raw);
    const transmission = transmissionRef.current;
    if (!payload || payload.kind !== "ack" || !transmission) {
      return;
    }
    if (payload.sessionId !== transmission.sessionId) {
      return;
    }

    adjustCongestionWindow(transmission, payload);
    transmission.highestContiguous = Math.max(
      transmission.highestContiguous,
      payload.highestContiguous ?? 0,
    );
    transmission.missingFrameIds = payload.missingFrameIds || [];
    transmission.receivedCount = payload.receivedCount || 0;
    transmission.doneAcked = Boolean(payload.done);

    setReceiverAck(payload);
    setTick((value) => value + 1);

    if (payload.done) {
      transmission.phase = "completed";
      setPhase("completed");
      pushLog("Receiver confirmed final completion");
      return;
    }

    if (payload.highestContiguous >= 0 && transmission.phase === "awaiting-meta-ack") {
      transmission.phase = "sending-window";
      pushLog("Meta ACK received, switching to sliding window");
    }
  });

  useEffect(() => {
    if (!prepared) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
    }, profile.frameCycleMs);

    return () => window.clearInterval(timer);
  }, [prepared, profile.frameCycleMs]);

  useEffect(() => {
    let cancelled = false;

    async function renderCurrentFrame() {
      const transmission = transmissionRef.current;
      if (!transmission) {
        setQrDataUrl("");
        setCurrentFrameId(null);
        return;
      }

      const currentTime = nowMs();
      let frameIdToShow = null;
      let nextPhase = transmission.phase;

      if (transmission.phase === "awaiting-meta-ack") {
        frameIdToShow = 0;
        const lastSentAt = transmission.lastSentAt[0] || 0;
        if (!lastSentAt || currentTime - lastSentAt >= transmission.profile.retransmitAfterMs) {
          transmission.lastSentAt[0] = currentTime;
        }
      } else if (transmission.phase === "sending-window") {
        const totalChunkFrames = transmission.frames.length - 1;
        if (transmission.highestContiguous >= totalChunkFrames) {
          transmission.phase = "awaiting-done-ack";
          setTick((value) => value + 1);
          return;
        }

        const baseFrameId = clamp(transmission.highestContiguous + 1, 1, totalChunkFrames);
        const windowEnd = Math.min(totalChunkFrames, baseFrameId + transmission.windowSize - 1);
        const priorityFrameIds = [
          ...transmission.missingFrameIds.filter(
            (frameId) => frameId >= baseFrameId && frameId <= windowEnd,
          ),
        ];

        for (let frameId = baseFrameId; frameId <= windowEnd; frameId += 1) {
          if (!priorityFrameIds.includes(frameId)) {
            priorityFrameIds.push(frameId);
          }
        }

        const overdueFrameId = priorityFrameIds.find((frameId) => {
          const sentAt = transmission.lastSentAt[frameId] || 0;
          return !sentAt || currentTime - sentAt >= transmission.profile.retransmitAfterMs;
        });

        if (overdueFrameId) {
          transmission.ssthresh = Math.max(
            transmission.profile.minWindowSize,
            Math.floor(transmission.windowSize / 2),
          );
          transmission.windowSize = Math.max(
            transmission.profile.minWindowSize,
            Math.floor(transmission.windowSize / 2),
          );
          transmission.congestionState = "timeout-recovery";
          transmission.lossEvents += 1;
          transmission.ackAccumulator = 0;
        }

        frameIdToShow =
          overdueFrameId ||
          priorityFrameIds[transmission.cycleIndex % Math.max(priorityFrameIds.length, 1)];

        transmission.cycleIndex += 1;
        transmission.lastSentAt[frameIdToShow] = currentTime;
      } else if (transmission.phase === "awaiting-done-ack") {
        setCurrentFrameId(transmission.frames.length);
        setPhase("awaiting-done-ack");
        setQrDataUrl(transmission.doneQr);
        return;
      } else if (transmission.phase === "completed") {
        return;
      }

      if (frameIdToShow === null || cancelled) {
        return;
      }

      setCurrentFrameId(frameIdToShow);
      setPhase(nextPhase);
      setQrDataUrl(transmission.qrCache[frameIdToShow]);
    }

    renderCurrentFrame();
    return () => {
      cancelled = true;
    };
  }, [prepared, tick]);

  const progress = useMemo(() => {
    const transmission = transmissionRef.current;
    if (!transmission) {
      return 0;
    }
    const chunkFrames = transmission.frames.length - 1;
    return Math.round((transmission.highestContiguous / Math.max(chunkFrames, 1)) * 100);
  }, [tick, prepared]);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    onFullscreen();
    setPhase("preparing");
    pushLog(`Preparing ${file.name} with ${profile.label} mode`);
    const payload = await imageFileToPayload(file, profile);
    const body = {
      fileName: payload.fileName,
      encodedType: payload.encodedType,
      originalType: payload.originalType,
      width: payload.width,
      height: payload.height,
      imageData: payload.dataUrl,
    };
    const bodyString = JSON.stringify(body);
    const chunks = splitText(bodyString, profile.chunkSize);
    const sessionId = makeSessionId();
    const frames = [
      {
        kind: "meta",
        sessionId,
        frameId: 0,
        totalFrames: chunks.length + 1,
        chunkCount: chunks.length,
        fileName: payload.fileName,
        profileId: profile.id,
      },
      ...chunks.map((chunk, index) => ({
        kind: "chunk",
        sessionId,
        frameId: index + 1,
        totalFrames: chunks.length + 1,
        chunkIndex: index,
        chunkCount: chunks.length,
        payload: chunk,
      })),
    ];

    pushLog(`Encoding ${frames.length} QR frames`);
    const qrCache = await buildQrCache(frames, profile);
    const doneFrame = {
      kind: "done",
      sessionId,
      frameId: frames.length,
      totalFrames: frames.length,
      sentAt: nowMs(),
    };
    const nextDoneQr = await frameToQrDataUrl(doneFrame, profile, profile.dataQrWidth);

    transmissionRef.current = {
      sessionId,
      previewUrl: payload.dataUrl,
      frames,
      qrCache,
      doneQr: nextDoneQr,
      highestContiguous: -1,
      missingFrameIds: [0],
      receivedCount: 0,
      phase: "awaiting-meta-ack",
      lastSentAt: {},
      cycleIndex: 0,
      doneAcked: false,
      profile,
      windowSize: profile.windowSize,
      ssthresh: profile.maxWindowSize,
      congestionState: "slow-start",
      ackAccumulator: 0,
      lossEvents: 0,
    };

    setDoneQr(nextDoneQr);
    setPrepared({
      sessionId,
      fileName: payload.fileName,
      previewUrl: payload.dataUrl,
      totalFrames: frames.length,
      chunks: chunks.length,
      profileLabel: profile.label,
    });
    setReceiverAck(null);
    setCurrentFrameId(0);
    setQrDataUrl(qrCache[0]);
    setTick((value) => value + 1);
    pushLog(`Session ${sessionId} created with ${chunks.length} chunks`);
  }

  function resetTransfer() {
    transmissionRef.current = null;
    setPrepared(null);
    setPhase("idle");
    setLog([]);
    setReceiverAck(null);
    setCurrentFrameId(null);
    setQrDataUrl("");
    setDoneQr("");
    setTick(0);
  }

  const transmission = transmissionRef.current;

  return (
    <div className="workspace-grid">
      <section className="panel">
        <div className="panel-header">
          <h2>Sender</h2>
          <span className="badge badge-live">{phase}</span>
        </div>
        <p className="muted">
          使用滑動視窗送多個 frame，接收端回報累積 ACK 與缺片清單。這版會先預編碼所有資料 QR，輪播時只切換快取。
        </p>
        <SpeedSelector profileId={profileId} onChange={onProfileChange} />
        <div className="control-row">
          <label className="file-input">
            <span>選擇照片</span>
            <input type="file" accept="image/*" onChange={handleFileChange} />
          </label>
          <button className="secondary-button" onClick={onFullscreen}>
            全螢幕
          </button>
          <button className="secondary-button" onClick={resetTransfer}>
            重置
          </button>
        </div>
        {prepared ? (
          <div className="stats-grid">
            <div>
              <strong>Session</strong>
              <span>{prepared.sessionId}</span>
            </div>
            <div>
              <strong>Frames</strong>
              <span>{prepared.totalFrames}</span>
            </div>
            <div>
              <strong>Mode</strong>
              <span>{prepared.profileLabel}</span>
            </div>
            <div>
              <strong>Progress</strong>
              <span>{progress}%</span>
            </div>
            <div>
              <strong>Window</strong>
              <span>{transmission?.windowSize ?? profile.windowSize}</span>
            </div>
            <div>
              <strong>State</strong>
              <span>{transmission?.congestionState ?? "idle"}</span>
            </div>
          </div>
        ) : null}
        <div className="qr-stage">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="Outgoing QR frame" className="qr-image qr-image-large" />
          ) : (
            <div className="empty-state">等待選擇照片</div>
          )}
        </div>
        <p className="tiny">
          {currentFrameId !== null
            ? `Current frame ${currentFrameId}${transmission ? `, highest ACK ${Math.max(transmission.highestContiguous, 0)}` : ""}`
            : "尚未開始傳輸"}
        </p>
        {prepared?.previewUrl ? (
          <img src={prepared.previewUrl} alt="Prepared preview" className="preview-image" />
        ) : null}
      </section>

      <CameraPanel
        scanner={scanner}
        title="Scan Receiver ACK"
        helper="把接收端電腦顯示的 ACK QR 置中放進掃碼框。中央裁切區域比之前更大，避免旁邊雜訊干擾。"
      />

      <section className="panel log-panel">
        <div className="panel-header">
          <h3>Transfer Log</h3>
          <span className="badge badge-soft">{receiverAck ? "linked" : "waiting"}</span>
        </div>
        {receiverAck ? (
          <div className="tiny ack-summary">
            <div>Highest contiguous: {receiverAck.highestContiguous}</div>
            <div>Missing: {(receiverAck.missingFrameIds || []).join(", ") || "none"}</div>
            <div>Received chunks: {receiverAck.receivedCount}</div>
            <div>Congestion window: {transmission?.windowSize ?? profile.windowSize}</div>
            <div>Loss events: {transmission?.lossEvents ?? 0}</div>
          </div>
        ) : (
          <p className="tiny">尚未收到 ACK</p>
        )}
        <div className="log-list">
          {log.length
            ? log.map((item, index) => <div key={`${item}-${index}`}>{item}</div>)
            : <div>等待事件</div>}
        </div>
      </section>
    </div>
  );
}

function ReceiverView({ onFullscreen, profileId, onProfileChange }) {
  const profile = SPEED_PROFILES[profileId];
  const [meta, setMeta] = useState(null);
  const [chunks, setChunks] = useState({});
  const [ackFrame, setAckFrame] = useState(null);
  const [ackQr, setAckQr] = useState("");
  const [status, setStatus] = useState("waiting");
  const [imageUrl, setImageUrl] = useState("");
  const [events, setEvents] = useState([]);
  const rebuiltRef = useRef(false);
  const receivedFramesRef = useRef(new Set());
  const metaRef = useRef(null);
  const chunksRef = useRef({});

  const pushEvent = (line) => {
    setEvents((prev) => [line, ...prev].slice(0, 14));
  };

  const scanner = useQrScanner((raw) => {
    const payload = safeJsonParse(raw);
    if (!payload || (payload.kind !== "meta" && payload.kind !== "chunk" && payload.kind !== "done")) {
      return;
    }

    if (payload.kind === "meta") {
      const sameSession = metaRef.current?.sessionId === payload.sessionId;
      if (!sameSession) {
        rebuiltRef.current = false;
        receivedFramesRef.current = new Set([0]);
        chunksRef.current = {};
        setChunks({});
        setImageUrl("");
        setStatus("receiving");
        setMeta({
          sessionId: payload.sessionId,
          chunkCount: payload.chunkCount,
          totalFrames: payload.totalFrames,
          fileName: payload.fileName,
          profileId: payload.profileId || profile.id,
        });
        metaRef.current = {
          sessionId: payload.sessionId,
          chunkCount: payload.chunkCount,
          totalFrames: payload.totalFrames,
          fileName: payload.fileName,
          profileId: payload.profileId || profile.id,
        };
        pushEvent(`Meta received for ${payload.fileName}`);
      } else {
        receivedFramesRef.current.add(0);
        pushEvent("Meta retransmission detected");
      }

      setAckFrame(
        buildAckFrame(
          payload.sessionId,
          receivedFramesRef.current,
          payload.chunkCount,
          profile.ackMissingLimit,
          false,
        ),
      );
      return;
    }

    if (!metaRef.current || payload.sessionId !== metaRef.current.sessionId) {
      return;
    }

    if (payload.kind === "chunk") {
      receivedFramesRef.current.add(payload.frameId);
      setChunks((prev) => {
        if (prev[payload.chunkIndex]) {
          return prev;
        }
        pushEvent(`Chunk ${payload.chunkIndex + 1}/${payload.chunkCount} stored`);
        const next = { ...prev, [payload.chunkIndex]: payload.payload };
        chunksRef.current = next;
        return next;
      });
      setAckFrame(
        buildAckFrame(
          payload.sessionId,
          receivedFramesRef.current,
          metaRef.current.chunkCount,
          profile.ackMissingLimit,
          false,
        ),
      );
      return;
    }

    if (payload.kind === "done") {
      const ready =
        Object.keys(chunksRef.current).length === metaRef.current.chunkCount && rebuiltRef.current;
      setAckFrame(
        buildAckFrame(
          payload.sessionId,
          receivedFramesRef.current,
          metaRef.current.chunkCount,
          profile.ackMissingLimit,
          ready,
        ),
      );
      setStatus(ready ? "completed" : "awaiting-missing");
      pushEvent(
        ready ? "Sender done frame acknowledged" : "Done frame received but some chunks are still missing",
      );
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function renderAck() {
      if (!ackFrame) {
        setAckQr("");
        return;
      }
      const nextQr = await frameToQrDataUrl(ackFrame, profile, profile.ackQrWidth);
      if (!cancelled) {
        setAckQr(nextQr);
      }
    }

    renderAck();
    return () => {
      cancelled = true;
    };
  }, [ackFrame, profile]);

  useEffect(() => {
    if (!meta || rebuiltRef.current) {
      return;
    }

    const collected = Array.from({ length: meta.chunkCount }, (_, index) => chunks[index] || "");
    if (!collected.every(Boolean)) {
      return;
    }

    const body = safeJsonParse(collected.join(""));
    if (!body?.imageData) {
      pushEvent("Rebuild failed: invalid payload");
      return;
    }

    rebuiltRef.current = true;
    chunksRef.current = chunks;
    setImageUrl(body.imageData);
    setStatus("rebuilt");
    setAckFrame(
      buildAckFrame(
        meta.sessionId,
        receivedFramesRef.current,
        meta.chunkCount,
        profile.ackMissingLimit,
        false,
      ),
    );
    pushEvent(`Image rebuilt: ${body.fileName}`);
  }, [chunks, meta, profile]);

  const receivedCount = meta ? Object.keys(chunks).length : 0;
  const progress = meta ? Math.round((receivedCount / Math.max(meta.chunkCount, 1)) * 100) : 0;
  const missingPreview =
    meta &&
    Array.from({ length: meta.chunkCount }, (_, index) => index + 1).filter(
      (frameId) => !receivedFramesRef.current.has(frameId),
    );

  function resetReceiver() {
    receivedFramesRef.current = new Set();
    chunksRef.current = {};
    metaRef.current = null;
    rebuiltRef.current = false;
    setMeta(null);
    setChunks({});
    setAckFrame(null);
    setAckQr("");
    setStatus("waiting");
    setImageUrl("");
    setEvents([]);
  }

  return (
    <div className="workspace-grid">
      <section className="panel">
        <div className="panel-header">
          <h2>Receiver</h2>
          <span className="badge badge-live">{status}</span>
        </div>
        <p className="muted">
          接收端現在會回傳累積 ACK 與缺片列表。可先切速度模式，讓 ACK QR 大小和缺片回報策略跟環境匹配。
        </p>
        <SpeedSelector profileId={profileId} onChange={onProfileChange} />
        <div className="control-row">
          <button className="secondary-button" onClick={onFullscreen}>
            全螢幕
          </button>
          <button className="secondary-button" onClick={resetReceiver}>
            重置
          </button>
        </div>
        {meta ? (
          <div className="stats-grid">
            <div>
              <strong>Session</strong>
              <span>{meta.sessionId}</span>
            </div>
            <div>
              <strong>File</strong>
              <span>{meta.fileName}</span>
            </div>
            <div>
              <strong>Chunks</strong>
              <span>
                {receivedCount}/{meta.chunkCount}
              </span>
            </div>
            <div>
              <strong>Progress</strong>
              <span>{progress}%</span>
            </div>
          </div>
        ) : null}
        <div className="qr-stage">
          {ackQr ? (
            <img src={ackQr} alt="ACK QR frame" className="qr-image" />
          ) : (
            <div className="empty-state">等待來自 Sender 的 QR</div>
          )}
        </div>
        <p className="tiny">
          {ackFrame
            ? `ACK highest contiguous ${ackFrame.highestContiguous}, missing ${ackFrame.missingFrameIds.join(", ") || "none"}`
            : "尚未有 ACK 需要回送"}
        </p>
        {imageUrl ? <img src={imageUrl} alt="Received result" className="preview-image" /> : null}
      </section>

      <CameraPanel
        scanner={scanner}
        title="Scan Sender Data"
        helper="把送方的大 QR 盡量填滿中央取景框。這裡只掃中心區域，對焦成功率會比整畫面掃描高。"
      />

      <section className="panel log-panel">
        <div className="panel-header">
          <h3>Receiver Log</h3>
          <span className="badge badge-soft">{meta ? "locked" : "idle"}</span>
        </div>
        {meta ? (
          <div className="tiny ack-summary">
            <div>Missing frames: {missingPreview?.slice(0, 8).join(", ") || "none"}</div>
            <div>{missingPreview && missingPreview.length > 8 ? `+${missingPreview.length - 8} more` : "all visible"}</div>
          </div>
        ) : null}
        <div className="log-list">
          {events.length
            ? events.map((item, index) => <div key={`${item}-${index}`}>{item}</div>)
            : <div>等待 frame</div>}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState("sender");
  const [profileId, setProfileId] = useState("fast");

  function handleModeChange(nextMode) {
    setMode(nextMode);
    requestAppFullscreen();
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">QR Camera Photo Transfer</p>
          <h1>用兩台電腦的前置攝影機，透過 QR code 傳照片</h1>
          <p className="hero-copy">
            現在支援缺片重傳、滑動視窗加速、大尺寸掃碼框、速度模式切換，以及資料 QR 預先快取。
          </p>
        </div>
        <div className="mode-switch">
          <button
            className={mode === "sender" ? "mode-button active" : "mode-button"}
            onClick={() => handleModeChange("sender")}
          >
            Sender
          </button>
          <button
            className={mode === "receiver" ? "mode-button active" : "mode-button"}
            onClick={() => handleModeChange("receiver")}
          >
            Receiver
          </button>
          <button className="mode-button" onClick={requestAppFullscreen}>
            Fullscreen
          </button>
        </div>
      </header>

      <section className="info-strip">
        <div>1. 先在兩台電腦選一樣的速度模式，再切成 Sender / Receiver。</div>
        <div>2. Sender 會預先把所有資料 frame 轉成 QR，實際傳送時只做快取切換。</div>
        <div>3. Fast 最快，Reliable 最穩；環境光差或鏡頭難對焦時改用 Reliable。</div>
      </section>

      {mode === "sender" ? (
        <SenderView
          onFullscreen={requestAppFullscreen}
          profileId={profileId}
          onProfileChange={setProfileId}
        />
      ) : (
        <ReceiverView
          onFullscreen={requestAppFullscreen}
          profileId={profileId}
          onProfileChange={setProfileId}
        />
      )}
    </div>
  );
}
