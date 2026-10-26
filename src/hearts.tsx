import React, { useState } from "react";
import { Heart } from "lucide-react";
import { MAX_HEARTS, heartsLabel } from "../shared/hearts";
/** 1–5 hearts: filled ones show how much a wish is wanted. With onChange it is a picker. */
export function Hearts({
  value,
  onChange,
  size = 18,
}: {
  value: number;
  onChange?: (value: number) => void;
  size?: number;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  const icons = Array.from({ length: MAX_HEARTS }, (_, i) => (
    <Heart
      key={i}
      size={size}
      className={i < shown ? "heart filled" : "heart"}
      fill={i < shown ? "currentColor" : "none"}
      aria-hidden="true"
    />
  ));
  if (!onChange)
    return (
      <span className="hearts" role="img" aria-label={heartsLabel(value)}>
        {icons}
      </span>
    );
  return (
    <span
      className="hearts picker"
      role="radiogroup"
      aria-label="Насколько хочется"
      onMouseLeave={() => setHover(0)}
    >
      {icons.map((icon, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i + 1}
          aria-label={heartsLabel(i + 1)}
          title={heartsLabel(i + 1)}
          onMouseEnter={() => setHover(i + 1)}
          onFocus={() => setHover(i + 1)}
          onBlur={() => setHover(0)}
          onClick={() => onChange(i + 1)}
        >
          {icon}
        </button>
      ))}
    </span>
  );
}
