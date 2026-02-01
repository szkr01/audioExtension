/**
 * Drum Buss - Popup UI Controller
 */

class DrumBussUI {
    constructor() {
        this.params = {};
        this.enabled = false;
    }

    async init() {
        await this.loadSettings();
        await this.syncWithContent();
        this.setupEventListeners();
        this.updateUI();
    }

    async loadSettings() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['drumBussParams', 'drumBussEnabled'], (result) => {
                this.params = result.drumBussParams || this.getDefaultParams();
                this.enabled = result.drumBussEnabled || false;
                resolve();
            });
        });
    }

    getDefaultParams() {
        return {
            trim: 1,
            compEnabled: true,
            boom: 0,
            boomFreq: 60,
            decay: 50,
            dryWet: 100,
            outputGain: 0
        };
    }

    async syncWithContent() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                await chrome.tabs.sendMessage(tab.id, {
                    type: 'SET_ENABLED',
                    value: this.enabled
                });
                await chrome.tabs.sendMessage(tab.id, {
                    type: 'SET_ALL_PARAMS',
                    params: this.params
                });
            }
        } catch (e) {
            console.warn('Failed to sync with content script:', e);
        }
    }

    setupEventListeners() {
        // Power switch
        const powerSwitch = document.getElementById('power-switch');
        powerSwitch.addEventListener('change', (e) => {
            this.setEnabled(e.target.checked);
        });

        // Comp toggle
        document.getElementById('comp-toggle').addEventListener('click', () => {
            this.setParam('compEnabled', !this.params.compEnabled);
        });

        // Sliders
        const sliders = [
            { id: 'trim', param: 'trim', transform: (v) => v / 100 },
            { id: 'boom', param: 'boom' },
            { id: 'boom-freq', param: 'boomFreq' },
            { id: 'decay', param: 'decay' },
            { id: 'dry-wet', param: 'dryWet' },
            { id: 'output-gain', param: 'outputGain' }
        ];

        sliders.forEach(({ id, param, transform }) => {
            const slider = document.getElementById(id);
            if (slider) {
                slider.addEventListener('input', (e) => {
                    let value = parseFloat(e.target.value);
                    if (transform) value = transform(value);
                    this.setParam(param, value);
                });
            }
        });

        // Reset button
        document.getElementById('reset-btn').addEventListener('click', () => {
            this.reset();
        });
    }

    async setEnabled(enabled) {
        this.enabled = enabled;
        await this.saveSettings();
        await this.sendToContent('SET_ENABLED', { value: enabled });
        this.updateUI();
    }

    async setParam(name, value) {
        this.params[name] = value;
        await this.saveSettings();
        await this.sendToContent('SET_PARAM', { name, value });
        this.updateUI();
    }

    async sendToContent(type, data) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                await chrome.tabs.sendMessage(tab.id, { type, ...data });
            }
        } catch (e) {
            console.warn('Failed to send message:', e);
        }
    }

    async saveSettings() {
        await chrome.storage.local.set({
            drumBussParams: this.params,
            drumBussEnabled: this.enabled
        });
    }

    async reset() {
        this.params = this.getDefaultParams();
        this.enabled = false;
        await this.saveSettings();
        await this.syncWithContent();
        this.updateUI();
    }

    updateUI() {
        // Power switch
        document.getElementById('power-switch').checked = this.enabled;

        // Controls disabled state
        const controls = document.getElementById('controls');
        controls.classList.toggle('disabled', !this.enabled);

        // Comp toggle
        const compBtn = document.getElementById('comp-toggle');
        compBtn.classList.toggle('active', this.params.compEnabled);

        // Sliders and values
        this.updateSlider('trim', this.params.trim * 100, `${Math.round(this.params.trim * 100)}%`);
        this.updateSlider('boom', this.params.boom, `${this.params.boom}%`);
        this.updateSlider('boom-freq', this.params.boomFreq, `${this.params.boomFreq}Hz`);
        this.updateSlider('decay', this.params.decay, `${this.params.decay}%`);
        this.updateSlider('dry-wet', this.params.dryWet, `${this.params.dryWet}%`);
        this.updateSlider('output-gain', this.params.outputGain, `${this.params.outputGain > 0 ? '+' : ''}${this.params.outputGain}dB`);
    }

    updateSlider(id, value, displayValue) {
        const slider = document.getElementById(id);
        const valueEl = document.getElementById(`${id}-val`);
        if (slider) slider.value = value;
        if (valueEl) valueEl.textContent = displayValue;
    }
}

// Initialize
const ui = new DrumBussUI();
document.addEventListener('DOMContentLoaded', () => ui.init());
