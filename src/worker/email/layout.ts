export const BRAND_ORIGIN = 'https://gitflare.io';
export const LOGO_URL = `${BRAND_ORIGIN}/logo-512.png`;
export const COMPANY_LINE = 'nexarq AI (nexarq Technologies Pvt Ltd) · [COMPANY ADDRESS]';
export const SUPPORT_ADDRESS = 'support@gitflare.io';

export type EmailEdition = 'hosted' | 'self-hosted';
export interface EmailAction { label: string; url: string }
export interface EmailContent {
  subject: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  accent: string;
  paragraphs: string[];
  action: EmailAction;
  details?: Array<[label: string, value: string]>;
  note: string;
  reason: string;
}
export interface EmailContext { edition: EmailEdition; origin: string }
export interface RenderedEmail { subject: string; html: string; text: string }

const SANS = "'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "'Instrument Serif',Georgia,'Times New Roman',serif";
const ACCENT = '#F6821F';
const C = { canvas: '#08090b', card: '#101114', border: '#1f2126', panel: '#16181c', panelBorder: '#24272d', text: '#eceef1', body: '#c3c7cf', muted: '#9aa0ab', faint: '#8b919c', link: '#f6a35c', button: '#ffffff', buttonText: '#0b0c0e' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function plainLine(value: string, limit = 200): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function absoluteUrl(value: string): string {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.username || url.password || url.protocol !== 'https:' && !local) throw new Error('Email links must be absolute HTTPS URLs');
  return url.href;
}

function headingHtml(heading: string, accent: string): string {
  const at = accent ? heading.lastIndexOf(accent) : -1;
  if (at < 0) return escapeHtml(heading);
  return `${escapeHtml(heading.slice(0, at))}<em class="gf-accent" style="font-family:${SERIF};font-style:italic;font-weight:400;letter-spacing:-0.2px;color:${ACCENT}">${escapeHtml(accent)}</em>${escapeHtml(heading.slice(at + accent.length))}`;
}

function footer(context: EmailContext, reason: string): { html: string; text: string } {
  const link = (href: string, label: string) => `<a href="${escapeHtml(href)}" class="gf-foot-link" style="color:${C.muted};text-decoration:underline">${escapeHtml(label)}</a>`;
  const reasonHtml = `<p style="margin:0 0 10px">${escapeHtml(reason)}</p>`;
  if (context.edition === 'self-hosted') {
    const origin = absoluteUrl(context.origin);
    return {
      html: `${reasonHtml}<p style="margin:0">Sent by the self-hosted Gitflare installation at ${link(origin, new URL(origin).host)}. Contact its administrator with questions.</p>`,
      text: `${reason}\nSent by the self-hosted Gitflare installation at ${origin}. Contact its administrator with questions.`,
    };
  }
  const privacy = `${BRAND_ORIGIN}/privacy`; const terms = `${BRAND_ORIGIN}/terms`; const support = `${BRAND_ORIGIN}/support`;
  const dot = '&nbsp;&nbsp;·&nbsp;&nbsp;';
  return {
    html: `${reasonHtml}<p style="margin:0 0 10px">${link(privacy, 'Privacy')}${dot}${link(terms, 'Terms')}${dot}${link(support, 'Support')}${dot}${link(`mailto:${SUPPORT_ADDRESS}`, SUPPORT_ADDRESS)}</p><p style="margin:0">${escapeHtml(COMPANY_LINE)}</p>`,
    text: `${reason}\nPrivacy: ${privacy}\nTerms: ${terms}\nSupport: ${support} (${SUPPORT_ADDRESS})\n${COMPANY_LINE}`,
  };
}

export function renderEmail(content: EmailContent, context: EmailContext): RenderedEmail {
  const actionUrl = absoluteUrl(content.action.url);
  const href = escapeHtml(actionUrl);
  const label = escapeHtml(content.action.label);
  const foot = footer(context, content.reason);
  const details = content.details ?? [];
  const detailRows = details.map(([name, value], index) => `<tr><td class="gf-muted gf-label" style="padding:${index ? '12px' : '0'} 16px 0 0;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted};width:140px;vertical-align:top;white-space:nowrap">${escapeHtml(name)}</td><td class="gf-strong gf-value" style="padding:${index ? '12px' : '0'} 0 0;font-family:${SANS};font-size:14px;line-height:20px;font-weight:500;color:${C.text};word-break:break-word">${escapeHtml(value)}</td></tr>`).join('');
  const detailsBlock = details.length ? `<tr><td class="gf-pad" style="padding:8px 48px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="gf-panel" style="background:${C.panel};border:1px solid ${C.panelBorder};border-radius:14px"><tr><td class="gf-panel-pad" style="padding:20px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${detailRows}</table></td></tr></table></td></tr>` : '';
  const paragraphs = content.paragraphs.map(text => `<p class="gf-body" style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:27px;color:${C.body}">${escapeHtml(text)}</p>`).join('');
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<title>${escapeHtml(content.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
:root{color-scheme:dark light;supported-color-schemes:dark light}
body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:separate;mso-table-lspace:0;mso-table-rspace:0}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
@media (max-width:520px){
.gf-outer{padding:16px 10px 28px!important}.gf-pad{padding-left:24px!important;padding-right:24px!important}
.gf-band{padding:26px 24px 22px!important}.gf-heading{font-size:30px!important;line-height:36px!important}
.gf-panel-pad{padding:16px 18px!important}.gf-label{display:block!important;width:auto!important;padding-right:0!important;white-space:normal!important}.gf-value{display:block!important;padding-top:2px!important}.gf-eyebrow{display:none!important}
.gf-button{display:block!important;text-align:center!important}
}
@media (prefers-color-scheme:light){
.gf-canvas{background:#f4f4f2!important}.gf-card{background:#ffffff!important;border-color:#e4e4e1!important}
.gf-band{background-color:#fff6ee!important;background-image:radial-gradient(ellipse at 50% -20%,rgba(246,130,31,.22),rgba(246,130,31,0) 70%)!important;border-color:#f1e4d8!important}
.gf-heading,.gf-strong,.gf-wordmark{color:#18181b!important}.gf-body{color:#3f3f46!important}
.gf-muted,.gf-foot,.gf-foot-link,.gf-eyebrow{color:#5b5b63!important}.gf-accent{color:#b84f00!important}
.gf-panel{background:#fafaf9!important;border-color:#e7e5e1!important}.gf-rule{border-color:#e7e5e1!important}
.gf-link{color:#a54700!important}.gf-button{background:#0b0c0e!important;color:#ffffff!important;border-color:#0b0c0e!important}
}
</style>
</head>
<body class="gf-canvas" style="margin:0;padding:0;background:${C.canvas};font-family:${SANS}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.canvas};opacity:0">${escapeHtml(content.preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="gf-canvas" bgcolor="${C.canvas}" style="background:${C.canvas}">
<tr><td align="center" class="gf-outer" style="padding:40px 16px 48px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
<tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="gf-card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.border};border-radius:22px">
<tr><td class="gf-band" bgcolor="#120d09" style="padding:32px 48px 28px;background-color:#120d09;background-image:radial-gradient(ellipse at 50% -30%,rgba(246,130,31,.30),rgba(246,130,31,.06) 45%,rgba(246,130,31,0) 72%);border-bottom:1px solid #2a1d12;border-radius:22px 22px 0 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle"><a href="${BRAND_ORIGIN}" style="text-decoration:none"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;padding-right:12px"><img src="${LOGO_URL}" width="36" height="36" alt="Gitflare logo" style="display:block;width:36px;height:36px;border-radius:9px"></td>
<td class="gf-wordmark" style="vertical-align:middle;font-family:${SANS};font-size:23px;line-height:28px;font-weight:600;letter-spacing:-0.4px;color:${C.text}">Git<em style="font-family:${SERIF};font-style:italic;font-weight:400;letter-spacing:0;color:${ACCENT}">flare</em></td>
</tr></table></a></td>
<td align="right" class="gf-eyebrow" style="vertical-align:middle;font-family:${SANS};font-size:11px;line-height:16px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:${C.muted}">${escapeHtml(content.eyebrow)}</td>
</tr></table>
</td></tr>
<tr><td class="gf-pad" style="padding:44px 48px 12px">
<h1 class="gf-heading" style="margin:0 0 22px;font-family:${SANS};font-size:38px;line-height:44px;font-weight:600;letter-spacing:-1.2px;color:${C.text}">${headingHtml(content.heading, content.accent)}</h1>
${paragraphs}
</td></tr>
${detailsBlock}
<tr><td class="gf-pad" style="padding:28px 48px 8px">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:280px" arcsize="50%" strokecolor="#d0d6df" fillcolor="${C.button}"><w:anchorlock/><center style="color:${C.buttonText};font-family:Arial,sans-serif;font-size:16px;font-weight:bold">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${href}" class="gf-button" style="display:inline-block;background:${C.button};color:${C.buttonText};border:1px solid #d0d6df;font-family:${SANS};font-size:16px;line-height:20px;font-weight:600;text-decoration:none;padding:15px 32px;border-radius:999px">${label}&nbsp;&nbsp;&rarr;</a><!--<![endif]-->
</td></tr>
<tr><td class="gf-pad" style="padding:20px 48px 0">
<p class="gf-muted" style="margin:0 0 6px;font-family:${SANS};font-size:13px;line-height:20px;color:${C.muted}">Button not working? Paste this link into your browser:</p>
<p style="margin:0;font-family:${SANS};font-size:13px;line-height:20px;word-break:break-all"><a href="${href}" class="gf-link" style="color:${C.link};text-decoration:underline">${escapeHtml(actionUrl)}</a></p>
</td></tr>
<tr><td class="gf-pad" style="padding:32px 48px 44px">
<p class="gf-muted gf-rule" style="margin:0;padding-top:24px;border-top:1px solid ${C.border};font-family:${SANS};font-size:14px;line-height:23px;color:${C.muted}">${escapeHtml(content.note)}</p>
</td></tr>
</table>
</td></tr>
<tr><td class="gf-pad gf-foot" style="padding:28px 48px 0;font-family:${SANS};font-size:12px;line-height:19px;color:${C.faint}">${foot.html}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  const detailText = details.map(([name, value]) => `${name}: ${value}`).join('\n');
  const text = ['Gitflare', content.heading, content.paragraphs.join('\n\n'), detailText, `${content.action.label}:\n${actionUrl}`, content.note, `--\n${foot.text}`].filter(Boolean).join('\n\n');
  return { subject: content.subject, html, text: `${text}\n` };
}
