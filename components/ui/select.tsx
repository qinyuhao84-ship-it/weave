"use client";

import * as React from "react";
import * as Ariakit from "@ariakit/react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

type Option = { value: string; label: string; disabled?: boolean };
type Props = React.SelectHTMLAttributes<HTMLSelectElement> & { searchable?: boolean };

function collectOptions(children: React.ReactNode): Option[] {
  const options: Option[] = [];
  React.Children.forEach(children, child => {
    if (!React.isValidElement<{ value?: string; children?: React.ReactNode; disabled?: boolean }>(child)) return;
    if (child.type === "option") options.push({ value: String(child.props.value ?? child.props.children ?? ""), label: String(child.props.children ?? ""), disabled: child.props.disabled });
    else options.push(...collectOptions(child.props.children));
  });
  return options;
}

/** Ariakit owns searching, keyboard selection, popup positioning and focus restoration. */
export function Select({ children, className, value, defaultValue, onChange, searchable, disabled, id, name, required, form, title, autoFocus, ...props }: Props) {
  const { t } = useI18n();
  const options = collectOptions(children);
  const [internal, setInternal] = React.useState(String(defaultValue ?? options[0]?.value ?? ""));
  const [query, setQuery] = React.useState("");
  const selected = String(value ?? internal);
  const search = searchable ?? options.length > 10;
  const matches = options.filter(option => !query.trim() || option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const commit = (raw: string) => {
    setInternal(raw);
    // Preserve the existing Select API: consumers only read target.value.
    const target = { value: raw, name: name ?? "", id: id ?? "" } as HTMLSelectElement;
    onChange?.({ target, currentTarget: target } as React.ChangeEvent<HTMLSelectElement>);
  };
  const label = props["aria-label"] ?? t("select.label");
  const triggerProps = {
    id, name, required, form, title, autoFocus, disabled,
    "aria-label": props["aria-label"], "aria-labelledby": props["aria-labelledby"], "aria-describedby": props["aria-describedby"], "data-value": selected,
    className: cn("flex h-11 sm:h-9 w-full min-w-0 items-center justify-between gap-3 rounded-[12px] border border-input bg-card px-3 text-left text-base sm:text-[13px] transition-colors hover:border-[color-mix(in_srgb,var(--foreground)_28%,transparent)] disabled:cursor-not-allowed disabled:opacity-50", className),
  };
  const triggerContent = <><span className="block min-w-0 truncate">{options.find(option => option.value === selected)?.label ?? selected}</span><ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden /></>;
  const optionContent = (option: Option) => <><span className="min-w-0 flex-1">{option.label}</span>{selected === option.value && <Check size={14} className="shrink-0" aria-hidden />}</>;
  if (search) return <Ariakit.ComboboxProvider selectedValue={selected} setSelectedValue={commit} value={query} setValue={setQuery} resetValueOnHide>
    <Ariakit.ComboboxSelect {...triggerProps}>{triggerContent}</Ariakit.ComboboxSelect>
    <Ariakit.ComboboxPopover role="dialog" aria-label={label} gutter={6} sameWidth portal unmountOnHide className="selection-popover select-popup">
      <div className="flex items-center gap-2 border-b border-border px-2 pb-2 pt-1">
        <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        <Ariakit.ComboboxInput autoFocus aria-label={t("select.search")} placeholder={t("select.search")} className="h-9 min-w-0 flex-1 rounded-md bg-transparent px-1 text-base sm:text-[13px] outline-offset-0" />
      </div>
      <Ariakit.ComboboxList aria-label={label} className="select-viewport">
        {matches.map(option => <Ariakit.ComboboxItem key={option.value} value={option.value} disabled={option.disabled} data-value={option.value} className="selection-option">{optionContent(option)}</Ariakit.ComboboxItem>)}
      </Ariakit.ComboboxList>
      {matches.length === 0 && <p role="status" className="px-3 py-5 text-center text-[12.5px] text-muted-foreground">{t("select.empty")}</p>}
    </Ariakit.ComboboxPopover>
  </Ariakit.ComboboxProvider>;
  return <Ariakit.SelectProvider value={selected} setValue={commit}>
    <Ariakit.Select {...triggerProps}>{triggerContent}</Ariakit.Select>
    <Ariakit.SelectPopover aria-label={label} gutter={6} sameWidth portal unmountOnHide className="selection-popover select-popup">
      {options.map(option => <Ariakit.SelectItem key={option.value} value={option.value} disabled={option.disabled} data-value={option.value} className="selection-option">{optionContent(option)}</Ariakit.SelectItem>)}
    </Ariakit.SelectPopover>
  </Ariakit.SelectProvider>;
}
