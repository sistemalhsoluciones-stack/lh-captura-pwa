(() => {
  const $ = (id) => document.getElementById(id);
  const consent = $("consent");
  const recBtn = $("recBtn");
  const openMeeting = $("openMeeting");
  const timerEl = $("timer");
  const statusEl = $("status");
  const transcriptEl = $("transcript");
  const result = $("result");
  const deliveryEl = $("delivery");
  const retrieveLink = $("retrieveLink");
  const downloadLocal = $("downloadLocal");

  let mediaRecorder = null;
  let chunks = [];
  let stream = null;
  let startedAt = null;
  let timerIv = null;
  let recognition = null;
  let transcriptParts = [];
  let lastBlob = null;
  let lastMeta = null;
  let sessionId = null;

  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const m = String(Math.floor(s / 60)).padStart(2, "0");
    const r = String(s % 60).padStart(2, "0");
    return m + ":" + r;
  }

  function syncEnabled() {
    recBtn.disabled = !consent.checked;
    const url = $("meetingUrl").value.trim();
    openMeeting.disabled = !url;
  }
  consent.addEventListener("change", syncEnabled);
  $("meetingUrl").addEventListener("input", syncEnabled);

  openMeeting.addEventListener("click", () => {
    const url = $("meetingUrl").value.trim();
    if (!url) return;
    window.open(url, "_blank", "noopener");
    statusEl.textContent = "Junta abierta. Pulsa Iniciar para grabar el micrófono.";
  });

  function startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    transcriptParts = [];
    if (!SR) {
      transcriptEl.textContent = "(Web Speech no disponible en este navegador — el audio se guardará igual)";
      return;
    }
    recognition = new SR();
    recognition.lang = "es-MX";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) transcriptParts.push(t.trim());
        else interim += t;
      }
      transcriptEl.textContent = (transcriptParts.join(" ") + " " + interim).trim() || "—";
    };
    recognition.onerror = () => {};
    try { recognition.start(); } catch (_) {}
  }

  function stopSpeech() {
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
  }

  async function startRec() {
    sessionId = uuid();
    chunks = [];
    startedAt = Date.now();
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
    mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = onStop;
    mediaRecorder.start(1000);
    startSpeech();
    recBtn.textContent = "Detener";
    recBtn.classList.add("recording");
    statusEl.textContent = "Grabando…";
    timerIv = setInterval(() => { timerEl.textContent = fmt(Date.now() - startedAt); }, 250);
  }

  function stopRec() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    stopSpeech();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    clearInterval(timerIv);
    recBtn.textContent = "Iniciar";
    recBtn.classList.remove("recording");
    statusEl.textContent = "Procesando y subiendo a la nube…";
  }

  async function onStop() {
    const mime = (chunks[0] && chunks[0].type) || "audio/webm";
    lastBlob = new Blob(chunks, { type: mime });
    const duration_ms = Date.now() - startedAt;
    const transcript = transcriptParts.join(" ").trim();
    const participants = $("participants").value.split(",").map((s) => s.trim()).filter(Boolean);
    lastMeta = {
      session_id: sessionId,
      product: "LH Captura",
      version: "0.3-mvp",
      project_tag: $("project").value.trim() || null,
      meeting_url: $("meetingUrl").value.trim() || null,
      mode: $("meetingUrl").value.trim() ? "A_mic_with_meeting_link" : "A_mic",
      mode_b_bot_join: false,
      mode_b_note: "Auto-join Zoom/Teams requiere SDK/tenant; no activo en este MVP.",
      consent: true,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms,
      duration_human: fmt(duration_ms),
      participants,
      transcript_raw: transcript,
      transcript_status: transcript ? "ok_web_speech" : "pending_manual",
      timestamps: [{ t0_ms: 0, t1_ms: duration_ms, label: "session" }],
      device: { ua: navigator.userAgent, lang: navigator.language },
      cloud: "netlify_blobs",
    };

    try {
      const fd = new FormData();
      fd.append("session_id", sessionId);
      fd.append("metadata", JSON.stringify(lastMeta));
      fd.append("audio", lastBlob, sessionId + (mime.includes("mp4") ? ".mp4" : ".webm"));
      const res = await fetch("/api/session-upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "upload failed");
      lastMeta.retrieve_url = json.retrieve_url;
      statusEl.textContent = "Guardado en la nube";
      showResult(json.retrieve_url);
      await idbSave(null);
    } catch (e) {
      statusEl.textContent = "Sin red o error de subida — paquete en cola local";
      await idbSave({ meta: lastMeta, audio: lastBlob });
      showResult(null);
      retryUpload();
    }
  }

  function showResult(url) {
    result.hidden = false;
    deliveryEl.textContent = JSON.stringify(lastMeta, null, 2);
    if (url) {
      retrieveLink.href = url;
      retrieveLink.style.display = "";
      retrieveLink.textContent = "Abrir sesión en la nube";
    } else {
      retrieveLink.style.display = "none";
    }
  }

  downloadLocal.addEventListener("click", async () => {
    if (!lastMeta || !lastBlob) return;
    const metaBlob = new Blob([JSON.stringify(lastMeta, null, 2)], { type: "application/json" });
    const a1 = document.createElement("a");
    a1.href = URL.createObjectURL(metaBlob);
    a1.download = (sessionId || "session") + "-delivery.json";
    a1.click();
    const a2 = document.createElement("a");
    a2.href = URL.createObjectURL(lastBlob);
    a2.download = (sessionId || "session") + "-audio.webm";
    a2.click();
  });

  recBtn.addEventListener("click", async () => {
    if (recBtn.classList.contains("recording")) {
      stopRec();
      return;
    }
    try {
      await startRec();
    } catch (e) {
      statusEl.textContent = "No se pudo abrir el micrófono: " + e.message;
    }
  });

  // IndexedDB queue
  function idb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open("lh-captura", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("queue");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSave(item) {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction("queue", "readwrite");
      if (item) tx.objectStore("queue").put(item, "pending");
      else tx.objectStore("queue").delete("pending");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function retryUpload() {
    try {
      const db = await idb();
      const item = await new Promise((res) => {
        const tx = db.transaction("queue", "readonly");
        const g = tx.objectStore("queue").get("pending");
        g.onsuccess = () => res(g.result);
        g.onerror = () => res(null);
      });
      if (!item) return;
      const fd = new FormData();
      fd.append("session_id", item.meta.session_id);
      fd.append("metadata", JSON.stringify(item.meta));
      fd.append("audio", item.audio, item.meta.session_id + ".webm");
      const r = await fetch("/api/session-upload", { method: "POST", body: fd });
      const j = await r.json();
      if (r.ok && j.ok) {
        await idbSave(null);
        lastMeta = item.meta;
        lastMeta.retrieve_url = j.retrieve_url;
        statusEl.textContent = "Cola local subida a la nube";
        showResult(j.retrieve_url);
      }
    } catch (_) {}
  }
  setInterval(retryUpload, 15000);
  retryUpload();
  syncEnabled();
})();