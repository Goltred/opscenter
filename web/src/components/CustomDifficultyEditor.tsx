import {
  DIFFICULTY_OPTIONS,
  OPTION_LABELS_2,
  OPTION_LABELS_3_PING,
  OPTION_LABELS_3P,
  type CustomDifficulty,
} from "../arma/difficultyOptions";

function optionValueLabel(key: string, value: number, max: number): string {
  if (key === "tacticalPing") return OPTION_LABELS_3_PING[value] || String(value);
  if (key === "thirdPersonView") return OPTION_LABELS_3P[value] || String(value);
  if (max === 2) return OPTION_LABELS_2[value] || String(value);
  return String(value);
}

export function CustomDifficultyEditor({
  value,
  onChange,
}: {
  value: CustomDifficulty;
  onChange: (next: CustomDifficulty) => void;
}) {
  const groups = [...new Set(DIFFICULTY_OPTIONS.map((o) => o.group))];

  function setOption(key: string, optionValue: number) {
    onChange({ ...value, options: { ...value.options, [key]: optionValue } });
  }

  return (
    <div className="difficulty-editor">
      {groups.map((group) => {
        const options = DIFFICULTY_OPTIONS.filter((o) => o.group === group);
        return (
          <section key={group} className="difficulty-section">
            <h3 className="difficulty-section-title">{group}</h3>
            <div className="difficulty-option-grid">
              {options.map((o) => (
                <div key={o.key} className="difficulty-option-row">
                  <span className="difficulty-option-label">{o.label}</span>
                  {o.max === 1 ? (
                    <label className="difficulty-option-check">
                      <input
                        type="checkbox"
                        checked={!!value.options[o.key]}
                        onChange={(e) => setOption(o.key, e.target.checked ? 1 : 0)}
                      />
                      <span>On</span>
                    </label>
                  ) : (
                    <select
                      className="difficulty-option-control"
                      value={value.options[o.key] ?? 0}
                      onChange={(e) => setOption(o.key, Number(e.target.value))}
                    >
                      {Array.from({ length: o.max + 1 }, (_, i) => (
                        <option key={i} value={i}>
                          {optionValueLabel(o.key, i, o.max)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <section className="difficulty-section">
        <h3 className="difficulty-section-title">AI</h3>
        <div className="difficulty-ai-grid">
          <div>
            <label>AI level preset</label>
            <select
              value={value.aiLevelPreset}
              onChange={(e) => onChange({ ...value, aiLevelPreset: Number(e.target.value) })}
            >
              <option value={0}>Low</option>
              <option value={1}>Normal</option>
              <option value={2}>High</option>
              <option value={3}>Custom</option>
            </select>
          </div>
          <div>
            <label>skillAI (0–1)</label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={value.skillAI}
              disabled={value.aiLevelPreset !== 3}
              onChange={(e) => onChange({ ...value, skillAI: Number(e.target.value) })}
            />
          </div>
          <div>
            <label>precisionAI (0–1)</label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={value.precisionAI}
              disabled={value.aiLevelPreset !== 3}
              onChange={(e) => onChange({ ...value, precisionAI: Number(e.target.value) })}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
