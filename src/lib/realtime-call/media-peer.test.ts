import { describe, expect, it, vi } from "vitest";

import { RealtimeMediaPeer } from "./media-peer";

describe("realtime media peer", () => {
  it("creates an audio-only AEC peer and closes every owner", async () => {
    const track = { enabled: true, stop: vi.fn() };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    const channel = { readyState: "open", send: vi.fn(), close: vi.fn(), addEventListener: vi.fn() };
    const peer = {
      addTrack: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(),
      setRemoteDescription: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
    };
    const getUserMedia = vi.fn(async () => stream);
    const audio = { srcObject: null, autoplay: false, currentTime: 0, play: vi.fn(async () => {}), pause: vi.fn() } as unknown as HTMLAudioElement;
    const media = new RealtimeMediaPeer({
      getUserMedia,
      createPeer: () => peer as unknown as RTCPeerConnection,
      audio,
    });
    expect(await media.createOffer()).toBe("offer-sdp");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(peer.addTrack).toHaveBeenCalledWith(track, stream);
    expect(peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    media.interruptVoice();
    expect(channel.send).toHaveBeenCalledWith(JSON.stringify({ type: "response.cancel" }));
    await media.applyAnswer("answer-sdp");
    media.setMuted(true);
    expect(track.enabled).toBe(false);
    await media.close();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
  });
});
