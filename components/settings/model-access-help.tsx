"use client";

import { useI18n } from "@/components/i18n-provider";

const guides = {
  deepseek: {
    steps: 10,
    links: { 1: "https://platform.deepseek.com/", 4: "https://platform.deepseek.com/api_keys" } as Record<number, string>,
    pricing: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    docs: "https://api-docs.deepseek.com/zh-cn/",
  },
  siliconflow: {
    steps: 9,
    links: { 1: "https://cloud.siliconflow.cn/", 2: "https://docs.siliconflow.cn/docs/userguide/faqs/authentication", 3: "https://cloud.siliconflow.cn/account/ak" } as Record<number, string>,
    pricing: "https://siliconflow.cn/pricing",
    docs: "https://docs.siliconflow.cn/docs/userguide/quickstart",
  },
};

/** Inline help keeps the form and the instructions visible together. No credentials are read. */
export function ModelAccessHelp({ service }: { service: keyof typeof guides }) {
  const { t } = useI18n();
  const guide = guides[service];
  const key = (suffix: string) => `modelAccess.${service}${suffix}`;
  const linkClass = "font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]";
  return <div className="space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">
    {service !== "deepseek" && <p><strong className="font-medium text-foreground">{t(key("Recommendation"))}</strong> {t(key("Cost"))}</p>}
    <details className="group/access">
      <summary className={`w-fit cursor-pointer rounded-sm ${linkClass}`}>{t(key("Guide"))}</summary>
      <div className="mt-3 space-y-4 text-[13px] leading-relaxed">
        <p>{t(key("Intro"))}</p>
        <ol className="list-decimal space-y-4 pl-5 marker:text-muted-foreground">
          {Array.from({ length: guide.steps }, (_, index) => index + 1).map(step => <li key={step} className="pl-1">
            <p className="font-medium text-foreground">{t(key(`Step${step}Title`))}</p>
            <p className="mt-1">{t(key(`Step${step}Body`))}</p>
            {guide.links[step] && <a className={`mt-1 inline-block ${linkClass}`} href={guide.links[step]} target="_blank" rel="noopener noreferrer">{t(key(`Step${step}Link`))}</a>}
          </li>)}
        </ol>
        <p>{t(key("Troubleshooting"))}</p>
        <p>{t(key("Billing"))}</p>
        <p className="text-[12px]">{t("modelAccess.checked")} {t("modelAccess.sharing")}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <a href={guide.pricing} target="_blank" rel="noopener noreferrer" className={linkClass}>{t("modelAccess.pricing")}</a>
          <a href={guide.docs} target="_blank" rel="noopener noreferrer" className={linkClass}>{t("modelAccess.docs")}</a>
        </div>
      </div>
    </details>
  </div>;
}
