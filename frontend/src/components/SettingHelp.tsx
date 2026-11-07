import { useId, useState } from "react";
import "./settingHelp.css";
export default function SettingHelp({ text }: { text: string }) {
  const id = useId(),
    [open, setOpen] = useState(false);
  return (
    <span className={`settings-help ${open ? "is-open" : ""}`}>
      <button
        type="button"
        aria-label="Setting explanation"
        aria-describedby={id}
        onClick={(event) => {
          event.preventDefault();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        ⓘ
      </button>
      <span id={id} role="tooltip">
        {text}
      </span>
    </span>
  );
}
