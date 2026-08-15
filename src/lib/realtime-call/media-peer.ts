export type RealtimePeerEvent = { type: string; [key: string]: unknown };

type MediaPeerOptions = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeer?: () => RTCPeerConnection;
  audio: HTMLAudioElement;
  deviceId?: string;
  onEvent?: (event: RealtimePeerEvent) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
};

export class RealtimeMediaPeer {
  private stream?: MediaStream;
  private peer?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private outboundEvents: string[] = [];

  constructor(private readonly options: MediaPeerOptions) {}

  async createOffer(): Promise<string> {
    if (this.peer) throw new Error("Realtime media peer already started");
    const getUserMedia = this.options.getUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    this.stream = await getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : {}),
      },
    });
    this.peer = (this.options.createPeer ?? (() => new RTCPeerConnection()))();
    for (const track of this.stream.getAudioTracks()) this.peer.addTrack(track, this.stream);
    // ChatGPT Realtime uses this channel for transcript, tool/delegation,
    // barge-in and context events while media remains on the audio track.
    this.dataChannel = this.peer.createDataChannel("oai-events");
    this.dataChannel.addEventListener("open", () => {
      const queued = this.outboundEvents;
      this.outboundEvents = [];
      for (const payload of queued) this.dataChannel?.send(payload);
    });
    this.dataChannel.addEventListener("message", (message) => {
      if (typeof message.data !== "string" || message.data.length > 1_000_000) return;
      try {
        const event = JSON.parse(message.data) as RealtimePeerEvent;
        if (event && typeof event.type === "string") this.options.onEvent?.(event);
      } catch {}
    });
    this.peer.addEventListener("track", (event) => {
      this.options.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      this.options.audio.autoplay = true;
      void this.options.audio.play().catch(() => {});
    });
    this.peer.addEventListener("connectionstatechange", () => this.options.onConnectionState?.(this.peer!.connectionState));
    const offer = await this.peer.createOffer({ offerToReceiveAudio: true });
    await this.peer.setLocalDescription(offer);
    if (!offer.sdp) throw new Error("WebRTC did not create an SDP offer");
    return offer.sdp;
  }

  async applyAnswer(answerSdp: string): Promise<void> {
    if (!this.peer) throw new Error("Realtime media peer is not started");
    await this.peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  interruptVoice(): void {
    this.options.audio.pause();
    this.options.audio.currentTime = 0;
    this.sendEvent({ type: "response.cancel" });
  }

  sendEvent(event: RealtimePeerEvent): void {
    const payload = JSON.stringify(event);
    if (this.dataChannel?.readyState === "open") this.dataChannel.send(payload);
    else if (this.outboundEvents.length < 32 && payload.length <= 1_000_000) this.outboundEvents.push(payload);
  }

  async close(): Promise<void> {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.dataChannel?.close();
    this.dataChannel = undefined;
    this.outboundEvents = [];
    this.peer?.close();
    this.peer = undefined;
    this.options.audio.pause();
    this.options.audio.srcObject = null;
  }
}
