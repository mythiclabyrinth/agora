import { Icon } from "../lib/icons";
import { armChimeNow, previewChime } from "../lib/chime";
import { useUiState } from "../state/ui";

/** Preferences in this section belong to this app install, not the server. */
export function NotificationSettings() {
  const soundEnabled = useUiState(s => s.soundEnabled);
  const setSoundEnabled = useUiState(s => s.setSoundEnabled);
  const soundVolume = useUiState(s => s.soundVolume);
  const setSoundVolume = useUiState(s => s.setSoundVolume);
  return <section className="notification-settings">
    <div className="settings-section-heading">
      <span className="settings-section-icon"><Icon name="volume-2" /></span>
      <div><h2>Notifications</h2><p>Play a sound when a new message arrives.</p></div>
    </div>
    <label className="notification-setting">
      <input type="checkbox" checked={soundEnabled} onChange={e => {
        const enabled = e.target.checked;
        setSoundEnabled(enabled);
        if (enabled) armChimeNow();
      }} />
      <span>Sound for new messages</span>
    </label>
    <div className={`notification-volume${soundEnabled ? "" : " disabled"}`}>
      <label htmlFor="chime-volume">Volume</label>
      <input id="chime-volume" type="range" min={0} max={100} step={5}
        aria-label="Chime volume" aria-valuetext={`${soundVolume}%`}
        value={soundVolume} disabled={!soundEnabled}
        onChange={e => setSoundVolume(Number(e.target.value))} />
      <span className="notification-volume-value">{soundVolume}%</span>
      <button type="button" className="btn sm" disabled={!soundEnabled}
        onClick={() => previewChime(soundVolume)}><Icon name="volume-2" /> Test</button>
    </div>
    <p className="appearance-note"><Icon name="info" /> Saved in this browser or app only. Other browsers and Agora apps keep their own setting.</p>
  </section>;
}
