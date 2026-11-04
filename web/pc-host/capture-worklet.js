/*
 * AudioWorklet for the PC host page: collects captured audio into fixed-size stereo chunks
 * and posts them to the main thread together with the AudioContext frame index of their
 * first sample. (The host page runs on http://localhost, which is a secure context, so
 * AudioWorklet is available there. Listener pages do not need it.)
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkFrames = (options.processorOptions && options.processorOptions.chunkFrames) || 960;
    this.left = new Float32Array(this.chunkFrames);
    this.right = new Float32Array(this.chunkFrames);
    this.filled = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const r = input[1] || input[0];
    let i = 0;
    while (i < l.length) {
      if (this.filled === 0) this.startFrame = currentFrame + i;
      const n = Math.min(l.length - i, this.chunkFrames - this.filled);
      this.left.set(l.subarray(i, i + n), this.filled);
      this.right.set(r.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === this.chunkFrames) {
        this.port.postMessage({ frame: this.startFrame, left: this.left, right: this.right }, [this.left.buffer, this.right.buffer]);
        this.left = new Float32Array(this.chunkFrames);
        this.right = new Float32Array(this.chunkFrames);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('syncspeaker-capture', CaptureProcessor);
