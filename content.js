/**
 * Drum Buss - Ableton Live Drum Buss Effect Recreation
 * Chrome Extension Content Script
 * 
 * Signal Flow:
 * Input → Trim → Comp → Boom (with sidechain ducking) → Dry/Wet → Output
 */

class DrumBuss {
    constructor() {
        this.audioContext = null;
        this.mediaElements = new Map();
        this.enabled = false;
        this.envelopeProcessors = new Map();

        // Default parameters
        this.params = {
            // Input Section
            trim: 1,           // 0-1 (gain)
            compEnabled: true,

            // Low-End Enhancement
            boom: 0,           // 0-100%
            boomFreq: 60,      // 30-90 Hz
            decay: 50,         // 0-100%

            // Output
            dryWet: 100,       // 0-100%
            outputGain: 0      // -Inf to +12 dB
        };
    }

    init() {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.observeMediaElements();
        this.processExistingElements();
        this.setupMessageListener();
    }

    observeMediaElements() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
                        this.processMediaElement(node);
                    }
                    if (node.querySelectorAll) {
                        node.querySelectorAll('audio, video').forEach(el => {
                            this.processMediaElement(el);
                        });
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    processExistingElements() {
        document.querySelectorAll('audio, video').forEach(el => {
            this.processMediaElement(el);
        });
    }

    /**
     * Register media element for later processing.
     * We don't create the audio processing chain immediately to avoid
     * blocking playback when AudioContext is suspended (Chrome Autoplay Policy).
     */
    processMediaElement(element) {
        if (this.mediaElements.has(element)) return;

        // Only register the element, don't create the processing chain yet
        // The chain will be created when the effect is enabled (user interaction)
        this.mediaElements.set(element, null);

        // If already enabled, create and connect the chain now
        if (this.enabled) {
            this.createAndConnectChain(element);
        }
    }

    /**
     * Create processing chain for an element and connect it.
     * This should only be called after user interaction (when AudioContext can be resumed).
     */
    createAndConnectChain(element) {
        try {
            const chain = this.createProcessingChain(element);
            this.mediaElements.set(element, chain);
            this.connectChain(chain);
        } catch (e) {
            console.warn('DrumBuss: Failed to process media element', e);
        }
    }

    createProcessingChain(element) {
        const source = this.audioContext.createMediaElementSource(element);

        // Input Section
        const trimGain = this.audioContext.createGain();
        const compressor = this.audioContext.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 12;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.15;

        // Sidechain detection (for kick detection)
        const sidechainFilter = this.audioContext.createBiquadFilter();
        sidechainFilter.type = 'lowpass';
        sidechainFilter.frequency.value = 100; // Detect kick frequencies
        sidechainFilter.Q.value = 1;

        // Boom (Resonant lowpass with sidechain ducking)
        const boomFilter = this.audioContext.createBiquadFilter();
        boomFilter.type = 'lowpass';
        boomFilter.frequency.value = this.params.boomFreq;
        boomFilter.Q.value = 8;

        const boomGain = this.audioContext.createGain();

        // Dry/Wet mix
        const dryGain = this.audioContext.createGain();
        const wetGain = this.audioContext.createGain();
        const merger = this.audioContext.createGain();

        // Output
        const outputGain = this.audioContext.createGain();

        return {
            source,
            trimGain,
            compressor,
            sidechainFilter,
            boomFilter,
            boomGain,
            dryGain,
            wetGain,
            merger,
            outputGain,
            element,
            envelopeValue: 0
        };
    }

    connectChain(chain) {
        const {
            source, trimGain, compressor, sidechainFilter,
            boomFilter, boomGain, dryGain, wetGain, merger, outputGain
        } = chain;

        // Disconnect all first
        try {
            source.disconnect();
            trimGain.disconnect();
            compressor.disconnect();
            sidechainFilter.disconnect();
            boomFilter.disconnect();
            boomGain.disconnect();
            dryGain.disconnect();
            wetGain.disconnect();
            merger.disconnect();
        } catch (e) {
            // Ignore disconnect errors
        }

        // Build the chain
        // Input → Trim → [Comp] → Wet path
        source.connect(trimGain);

        if (this.params.compEnabled) {
            trimGain.connect(compressor);
            compressor.connect(wetGain);
        } else {
            trimGain.connect(wetGain);
        }

        // Sidechain path: detect kick transients
        source.connect(sidechainFilter);

        // Boom path (低域強化 - with sidechain ducking)
        source.connect(boomFilter);
        boomFilter.connect(boomGain);
        boomGain.connect(wetGain);

        // Dry path
        source.connect(dryGain);

        // Mix
        dryGain.connect(merger);
        wetGain.connect(merger);
        merger.connect(outputGain);
        outputGain.connect(this.audioContext.destination);

        // Start envelope follower for sidechain
        this.startEnvelopeFollower(chain);

        this.updateChainParams(chain);
    }

    startEnvelopeFollower(chain) {
        // Stop existing processor if any
        this.stopEnvelopeFollower(chain);

        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;

        chain.sidechainFilter.connect(analyser);
        chain.analyser = analyser;

        const bufferLength = analyser.fftSize;
        const dataArray = new Float32Array(bufferLength);

        const targetBoomAmount = this.params.boom / 10;
        const attackTime = 0.005;  // Fast attack (5ms)
        const releaseTime = 0.1 + (this.params.decay / 100) * 0.4;  // Release based on decay

        let lastTime = this.audioContext.currentTime;
        let currentGain = 0;

        const processEnvelope = () => {
            if (!this.enabled || !this.mediaElements.has(chain.element)) {
                return;
            }

            const now = this.audioContext.currentTime;
            const deltaTime = now - lastTime;
            lastTime = now;

            // Get audio level
            analyser.getFloatTimeDomainData(dataArray);

            // Calculate RMS
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i] * dataArray[i];
            }
            const rms = Math.sqrt(sum / bufferLength);

            // Detect transient (kick)
            const threshold = 0.1;  // Transient detection threshold
            const isTransient = rms > threshold;

            // Calculate target gain
            const boomAmount = this.params.boom / 10;
            let targetGain;

            if (isTransient) {
                // Duck the boom when kick is detected
                targetGain = 0;
            } else {
                targetGain = boomAmount * 2;
            }

            // Smooth envelope following
            const alpha = isTransient
                ? 1 - Math.exp(-deltaTime / attackTime)
                : 1 - Math.exp(-deltaTime / releaseTime);

            currentGain = currentGain + alpha * (targetGain - currentGain);

            // Apply gain with smoothing
            const currentTime = this.audioContext.currentTime;
            chain.boomGain.gain.cancelScheduledValues(currentTime);
            chain.boomGain.gain.setTargetAtTime(currentGain, currentTime, 0.01);

            chain.envelopeAnimationId = requestAnimationFrame(processEnvelope);
        };

        chain.envelopeAnimationId = requestAnimationFrame(processEnvelope);
    }

    stopEnvelopeFollower(chain) {
        if (chain.envelopeAnimationId) {
            cancelAnimationFrame(chain.envelopeAnimationId);
            chain.envelopeAnimationId = null;
        }
        if (chain.analyser) {
            try {
                chain.analyser.disconnect();
            } catch (e) { }
            chain.analyser = null;
        }
    }

    disconnectChain(chain) {
        this.stopEnvelopeFollower(chain);

        try {
            chain.source.disconnect();
            chain.trimGain.disconnect();
            chain.compressor.disconnect();
            chain.sidechainFilter.disconnect();
            chain.boomFilter.disconnect();
            chain.boomGain.disconnect();
            chain.dryGain.disconnect();
            chain.wetGain.disconnect();
            chain.merger.disconnect();
        } catch (e) {
            // Ignore disconnect errors
        }
        chain.source.connect(this.audioContext.destination);
    }

    updateChainParams(chain) {
        const {
            trimGain, boomFilter, boomGain, dryGain, wetGain, outputGain
        } = chain;

        // Trim
        trimGain.gain.value = this.params.trim;

        // Boom filter settings
        const boomAmount = this.params.boom / 100;
        boomFilter.frequency.value = this.params.boomFreq;
        boomFilter.Q.value = 2 + boomAmount * 10;
        // Note: boomGain is controlled by envelope follower

        // Dry/Wet
        const wet = this.params.dryWet / 100;
        dryGain.gain.value = 1 - wet;
        wetGain.gain.value = wet;

        // Output gain (dB to linear)
        outputGain.gain.value = Math.pow(10, this.params.outputGain / 20);
    }

    setEnabled(enabled) {
        this.enabled = enabled;

        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        this.mediaElements.forEach((chain, element) => {
            if (enabled) {
                if (chain === null) {
                    // Chain not yet created - create it now (after user interaction)
                    this.createAndConnectChain(element);
                } else {
                    this.connectChain(chain);
                }
            } else {
                if (chain !== null) {
                    this.disconnectChain(chain);
                }
            }
        });
    }

    setParam(name, value) {
        if (name in this.params) {
            this.params[name] = value;

            if (this.enabled) {
                this.mediaElements.forEach((chain) => {
                    if (chain !== null) {
                        this.updateChainParams(chain);
                    }
                });
            }
        }
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            switch (message.type) {
                case 'SET_ENABLED':
                    this.setEnabled(message.value);
                    sendResponse({ success: true });
                    break;
                case 'SET_PARAM':
                    this.setParam(message.name, message.value);
                    sendResponse({ success: true });
                    break;
                case 'GET_PARAMS':
                    sendResponse({ params: this.params, enabled: this.enabled });
                    break;
                case 'SET_ALL_PARAMS':
                    Object.assign(this.params, message.params);
                    if (this.enabled) {
                        this.mediaElements.forEach((chain) => {
                            if (chain !== null) {
                                this.updateChainParams(chain);
                            }
                        });
                    }
                    sendResponse({ success: true });
                    break;
            }
            return true;
        });
    }
}

// Initialize
const drumBuss = new DrumBuss();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => drumBuss.init());
} else {
    drumBuss.init();
}
