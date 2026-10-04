import { Icon } from "../lib/icons";
import { useAppearance, type Appearance } from "../state/appearance";

const choices: { value: Appearance; icon: string; title: string; detail: string }[] = [
  { value: "light", icon: "sun", title: "Light", detail: "Bright and balanced" },
  { value: "dark", icon: "moon", title: "Dark", detail: "Calm and focused" },
  { value: "system", icon: "monitor", title: "System", detail: "Follow your device" },
];

export function AppearancePicker() {
  const { preference, resolved, setPreference } = useAppearance();
  return <section className="appearance-section" aria-labelledby="appearance-title">
    <div className="settings-section-heading">
      <span className="settings-section-icon"><Icon name="sun" /></span>
      <div><h2 id="appearance-title">Make yourself at home</h2>
        <p>Choose the look that works for you. Your preference stays on this device.</p></div>
    </div>
    <fieldset className="appearance-options">
      <legend className="ago-sr-only">Color theme</legend>
      {choices.map(choice => <label key={choice.value} className={`appearance-option ${preference === choice.value ? "selected" : ""}`}>
        <input type="radio" name="appearance" value={choice.value} checked={preference === choice.value}
          onChange={() => setPreference(choice.value)} />
        <span className={`appearance-preview preview-${choice.value}`} aria-hidden="true">
          <span className="preview-side"><i /><i /><i /></span>
          <span className="preview-main"><i /><i /><i /></span>
        </span>
        <span className="appearance-label"><Icon name={choice.icon} /><strong>{choice.title}</strong>
          <span className="appearance-check" aria-hidden="true">{preference === choice.value && <Icon name="check" />}</span></span>
        <span className="appearance-detail">{choice.detail}</span>
      </label>)}
    </fieldset>
    <p className="appearance-note"><Icon name="info" /> {preference === "system"
      ? `Your device is currently using ${resolved} mode. Agora will follow changes automatically.`
      : "Switch anytime. Your conversations and unsent messages stay exactly where they are."}</p>
  </section>;
}
