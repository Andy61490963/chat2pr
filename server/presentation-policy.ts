// 這個解析器只證明有限的畫面呈現語義，不嘗試替任意自然語言判定安全。
// 所有分支都必須消耗完整子句；未知字詞、主體或動作會保留原登入風險。
type Domain =
  "width" | "align" | "readable" | "scroll" | "preserve" | "annotation";
type Frame = {
  domain: Domain;
  label?: string;
  defined?: boolean;
  numericWidth?: number;
  login?: boolean;
  annotationDisplay?: boolean;
};
type Context = {
  fields: Set<string>;
  widths: Map<string, number | null>;
  previous?: Frame;
};

class Cursor {
  rest: string;
  constructor(text: string) {
    this.rest = text.trim();
  }
  take(...words: string[]) {
    for (const word of words.sort((a, b) => b.length - a.length)) {
      if (this.rest.startsWith(word)) {
        this.rest = this.rest.slice(word.length).trimStart();
        return word;
      }
    }
    return undefined;
  }
  match(pattern: RegExp) {
    const match = this.rest.match(pattern);
    if (!match || match.index !== 0) return undefined;
    this.rest = this.rest.slice(match[0].length).trimStart();
    return match[0];
  }
  get done() {
    return this.rest.length === 0;
  }
}
const key = (label: string) => label.trim().replace(/\s+/gu, " ");
const phone = /^手機(?:窄螢幕|螢幕|畫面|瀏覽|檢視|版)?(?:下|時|上)?/u;
const properties = [
  "欄位",
  "欄",
  "欄寬",
  "表頭",
  "欄頭",
  "標題",
  "儲存格",
  "資料列",
  "寬度",
  "實際",
  "顯示",
  "呈現",
  "所有",
  "各",
  "列",
  "的",
  "與",
  "及",
];
const fieldDefinitions = new Set([
  "欄位",
  "欄",
  "欄寬",
  "表頭",
  "欄頭",
  "標題",
]);
function propertyTokens(c: Cursor) {
  const result: string[] = [];
  for (let i = 0; i < 20; i++) {
    const p = c.take(...properties);
    if (!p) break;
    result.push(p);
  }
  return result;
}
function mood(c: Cursor) {
  c.take("皆", "均", "仍");
}
function existing(c: Cursor) {
  c.take("既有", "原有", "現有");
}
function principalInLocation(name: string): boolean {
  // 位置名稱不是用來表達誰能接觸誰的資料。含主體類別的未引號名稱即交人工，
  // 不推測中間未知動詞是否安全；名稱本身像群組/角色描述時也採相同保守規則。
  return (
    /(?:群組|團隊|部門|角色|使用者|用戶|帳號|成員|管理員|訪客|擁有者|操作者|群|組)/u.test(
      name,
    ) ||
    /\b(?:teams?|groups?|roles?|users?|accounts?|members?|departments?|admins?|guests?|visitors?|owners?|operators?)\b/iu.test(
      name,
    ) ||
    /\b(?:[Tt]eam|[Gg]roup|[Rr]ole|[Uu]ser|[Aa]ccount|[Mm]ember|[Dd]epartment|[Aa]dmin|[Gg]uest)[A-Z0-9]/u.test(
      name,
    )
  );
}
const quotedName = /^(?:「[^「」『』\r\n]{1,80}」|『[^「」『』\r\n]{1,80}』)$/u;
const boardNameToken = String.raw`(?:「[^「」『』\r\n]{1,80}」|『[^「」『』\r\n]{1,80}』|[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9 _/-]{0,63}?)`;
const boardPrefix = new RegExp(`^(?:(${boardNameToken})(?:的)?)?看板`, "u");
function presentationName(name: string): boolean {
  if (quotedName.test(name)) return true; // 明示引用只當資料；外層仍掃描原文敏感詞。
  if (principalInLocation(name)) return false;
  if (
    /^(?:准|給|授|讓|使|請|要|開放|放行)/u.test(name) ||
    /(?:可以|能夠|得以|允許|准許|授予|賦予|取得|擁有|具有|負責|必須|應該|需要|務必)/u.test(
      name,
    ) ||
    /.+(?:可|能|得|會|讓|使|要|應|需).+/u.test(name) ||
    /.+(?:管理|操作|控制|更新|修改|編輯|刪除|讀取|寫入|存取|查看|維護|核准|執行|進入|變更|讀|閱|看|寫|改|刪).+/u.test(
      name,
    ) ||
    /\b(?:can|may|must|shall|should|allows?|grants?|authorized|responsible)\b/iu.test(
      name,
    ) ||
    /\b(?:manages?|controls?|updates?|modif(?:y|ies)|deletes?|reads?|writes?|access(?:es)?)\b\s+\S+/iu.test(
      name,
    )
  )
    return false;
  const atoms =
    name.match(/[\p{Script=Han}]+|[A-Za-z][A-Za-z0-9_/-]*|[0-9]+/gu) ?? [];
  if (
    !atoms.length ||
    atoms.length > 6 ||
    atoms.join("") !== name.replace(/\s+/gu, "")
  )
    return false;
  const latin = atoms.filter((atom) => /^[A-Za-z]/u.test(atom));
  // 多詞英文名稱採名稱形式；小寫自然語句不能被吞成未引號欄名。
  if (latin.length > 1 && latin.some((atom) => /^[a-z]+$/u.test(atom)))
    return false;
  return atoms.every(
    (atom) =>
      !/^\p{Script=Han}/u.test(atom) ||
      [...atom].length <= 4 ||
      /^[\p{Script=Han}]{0,4}(?:(?:生產|管理|控制|設備|監控|現場|製造|資訊|排程|工單|產能|狀態|作業|即時|總覽|服務|資料|表格)){1,2}$/u.test(
        atom,
      ),
  );
}
function location(c: Cursor): boolean {
  const named = c.rest.match(boardPrefix);
  if (named) {
    const name = (named[1] ?? "").trim();
    if (name && !presentationName(name)) return false;
    c.rest = c.rest.slice(named[0].length).trimStart();
    c.take("的");
    if (c.take("表格")) c.take("的");
  }
  if (c.take("紅框")) c.take("標示的", "標註的", "所指的", "所示的");
  return true;
}
function fieldSubject(c: Cursor) {
  c.match(phone);
  const command = c.take("調整", "調寬", "加寬", "將", "把");
  if (!location(c)) return undefined;
  const label = c.match(
    /^(?:[「『][^「」『』\r\n]{1,40}[」』]|[A-Za-z][A-Za-z0-9 _/-]{0,79})/u,
  );
  if (!label || !presentationName(key(label))) return undefined;
  const props = propertyTokens(c);
  return {
    label: key(label),
    defined: props.some((p) => fieldDefinitions.has(p)),
    props,
    command,
  };
}
function widthValue(
  c: Cursor,
  subject: ReturnType<typeof fieldSubject>,
  context: Context,
) {
  if (c.take("指定寬度"))
    return subject &&
      context.fields.has(subject.label) &&
      typeof context.widths.get(subject.label) === "number"
      ? {}
      : undefined;
  if (c.take("圖中", "圖片")) {
    c.take("標註的");
    c.take("目標");
    if (c.take("寬度")) return {};
  }
  const value = c.match(/^\d{1,5}(?:\.\d{1,2})?/u);
  c.take("CSS");
  if (value && c.take("px")) return { numericWidth: Number(value) };
  return undefined;
}
function width(
  c: Cursor,
  subject: ReturnType<typeof fieldSubject>,
  context: Context,
): Frame | undefined {
  mood(c);
  c.take("一致");
  c.take(
    "調整為",
    "加寬為",
    "改為",
    "改成",
    "設為",
    "呈現為",
    "顯示為",
    "保持",
    "維持",
    "為",
  );
  c.take("一致");
  const value = widthValue(c, subject, context);
  if (!value || !c.done) return undefined;
  return { domain: "width", ...subject, ...value };
}
function alignment(c: Cursor): boolean {
  mood(c);
  c.take("保持", "維持");
  c.take("上下", "左右");
  return Boolean(c.take("對齊", "一致") && c.done);
}
function uncompressed(
  c: Cursor,
  subject: NonNullable<ReturnType<typeof fieldSubject>>,
  context: Context,
): boolean {
  if (!c.take("不")) return false;
  if (c.take("因")) {
    if (!c.take("窄螢幕")) {
      if (c.take("可視寬度")) {
        if (!c.take("不足")) return false;
      } else if (
        !c.take("螢幕", "畫面") ||
        !c.take("較窄", "變窄", "縮窄", "縮小")
      ) {
        return false;
      }
    }
    c.take("而");
  }
  c.take("被");
  if (!c.take("縮小", "壓縮", "縮減", "縮窄")) return false;
  if (c.done) return true;
  c.take("至", "到");
  const comparison = c.take("小於", "低於");
  const bound = widthValue(c, subject, context)?.numericWidth;
  if (!comparison && !c.take("以下")) return false;
  // 數值下限必須與同欄位明定的唯一寬度一致，不能借用別欄或矛盾規格。
  return (
    bound !== undefined && context.widths.get(subject.label) === bound && c.done
  );
}
function textContent(c: Cursor, allowContent: boolean): boolean {
  c.take("的");
  existing(c);
  c.take("的");
  const languages = ["中英文混合", "中英混合", "中英文", "中文", "英文"];
  const language = c.take(...languages);
  if (language && c.take("及", "與", "和") && !c.take(...languages))
    return false;
  c.take("的");
  c.take("範例");
  if (
    !c.take(
      "規格內容",
      "規格文字",
      "欄位文字",
      "表格文字",
      "畫面文字",
      "文字",
      ...(allowContent ? ["內容"] : []),
    )
  )
    return false;
  mood(c);
  if (c.take("不")) {
    if (
      !c.take("因") ||
      !c.take("截斷", "裁切") ||
      !c.take("而") ||
      !c.take("無法")
    )
      return false;
    c.take("完整");
    return Boolean(c.take("閱讀") && c.done);
  }
  if (c.take("可")) {
    c.take("完整");
    return Boolean(c.take("閱讀") && c.done);
  }
  c.take("完整");
  return Boolean(c.take("可讀") && c.done);
}
function readable(text: string, context: Context): Frame | undefined {
  const c = new Cursor(text);
  if (c.take("圖片所示的", "圖片所示", "圖片中的"))
    c.match(/^[一二三四五六七八九十0-9]+筆/u);
  const original = c.rest;
  const subject = fieldSubject(c);
  if (
    subject &&
    (subject.defined || context.fields.has(subject.label)) &&
    textContent(c, true)
  )
    return { domain: "readable", ...subject };
  if (textContent(new Cursor(original), false)) return { domain: "readable" };
  if (context.previous?.domain === "readable") {
    const continuation = new Cursor(text);
    // 「無」只描述剛確認的欄位文字呈現；不得推廣成任意否定或授權豁免。
    if (
      context.previous.label &&
      context.fields.has(context.previous.label) &&
      continuation.take("無")
    ) {
      let count = 0;
      do {
        if (!continuation.take("截斷", "裁切", "遮擋")) return undefined;
        count++;
      } while (count < 3 && continuation.take("或", "及", "與"));
      return continuation.done ? { ...context.previous } : undefined;
    }
    if (continuation.take("未", "不")) {
      if (continuation.take("因")) {
        if (!continuation.take("欄寬調整")) return undefined;
        continuation.take("而");
      }
      continuation.take("遭", "被", "會");
      if (continuation.take("截斷", "裁切") && continuation.done)
        return { ...context.previous };
    }
  }
  return undefined;
}
function columns(c: Cursor): boolean {
  c.take("所有", "全部", "其他", "各");
  c.take("的");
  return Boolean(c.take("欄位"));
}
function viewTarget(c: Cursor, context: Context): boolean {
  c.take("完整");
  if (c.take("表格")) {
    c.take("內容");
    return true;
  }
  if (!columns(c)) return false;
  if (c.take("與", "及", "和")) {
    c.take("完整");
    if (!c.take("資料", "內容")) {
      const subject = fieldSubject(c);
      if (!subject || subject.command || !context.fields.has(subject.label))
        return false;
      c.take("的");
      if (!c.take("內容")) return false;
    }
  }
  return true;
}
function scrollMood(c: Cursor) {
  mood(c);
  if (c.take("可", "能")) {
    c.take("正常");
    if (c.take("透過")) existing(c);
    return;
  }
  if (c.take("保留", "保持", "維持")) {
    existing(c);
    c.take("的");
  }
}
function scroll(text: string, context: Context): Frame | undefined {
  const c = new Cursor(text);
  const mobile = c.match(phone);
  if (mobile) {
    scrollMood(c);
    c.take("表格");
  } else if (!c.take("表格") && !columns(c)) {
    // 無主詞時只承接已完整辨識的捲動或明示欄位；不把任意前句當成畫面主體。
    const previousScroll = context.previous?.domain === "scroll";
    const previousField =
      context.previous?.label &&
      context.fields.has(context.previous.label) &&
      ["width", "align", "readable"].includes(context.previous.domain);
    if (!previousScroll && !previousField) return undefined;
    const follow = new Cursor(text);
    scrollMood(follow);
    follow.take("水平", "橫向");
    const movement = follow.take("捲動");
    if (!previousScroll && !movement) return undefined;
    follow.take("完整");
    if (
      follow.take("查看", "瀏覽") &&
      viewTarget(follow, context) &&
      follow.done
    )
      return { domain: "scroll" };
    return undefined;
  }
  scrollMood(c);
  c.take("水平", "橫向");
  if (!c.take("捲動")) return undefined;
  c.take("功能", "行為", "操作");
  if (c.done) return { domain: "scroll" };
  const tail = c.rest;
  // 捲動表格、捲動瀏覽表格、捲動並查看欄位是同一種只讀呈現動作。
  c.take("瀏覽");
  c.take("完整");
  if (c.take("表格")) {
    if (c.done) return { domain: "scroll" };
  } else c.rest = tail;
  c.take("並", "以");
  c.take("完整");
  if (!c.take("查看", "瀏覽")) return undefined;
  return c.done || (viewTarget(c, context) && c.done)
    ? { domain: "scroll" }
    : undefined;
}
function unchangedItem(
  item: string,
  fields: Set<string>,
  strict: boolean,
): boolean {
  if (/^(?:既有|原有)?登入功能$/u.test(item)) return true;
  if (
    /^(?:所有|全部)?(?:既有|原有|現有|顯示)?資料(?:內容)?$/u.test(item) ||
    item === "其他資料"
  )
    return !/^(?:所有|全部)/u.test(item) || fields.size > 0;
  if (/^手機(?:既有|原有|現有)?(?:橫向|水平)?捲動(?:行為|操作)?$/u.test(item))
    return true;
  if (
    !strict &&
    ["其餘功能", "既有功能", "原有功能", "內容", "其他"].includes(item)
  )
    return true;
  const c = new Cursor(item);
  const other = c.take("其他欄位");
  if (!other) {
    const label = c.match(/^[A-Za-z][A-Za-z0-9 _/-]{0,79}/u);
    if (!label || !fields.has(key(label))) return false;
    c.take("欄位");
  }
  c.take("的");
  existing(c);
  c.take("資料內容", "資料", "內容", "文字", "寬度", "設定");
  return c.done;
}
function preserve(text: string, context: Context): Frame | undefined {
  const subject =
    text.match(/^(?:完整)?保留(.+)$/u)?.[1] ??
    text.match(
      /^(.+?)(?:皆|均|仍)?(?:(?:維持|保持)?(?:正常運作|可正常使用|(?:原有|既有|現有|原)行為|正常|可用|不變|原樣|原狀|不受影響)|(?:完整)?保留)$/u,
    )?.[1];
  if (!subject) return undefined;
  const items = subject.split(/[、及與和]/u).map((s) => s.trim());
  const login = items.some((s) => /^(?:既有|原有)?登入功能$/u.test(s));
  if (
    items.length > 8 ||
    !items.every((s) => unchangedItem(s, context.fields, login))
  )
    return undefined;
  return { domain: "preserve", login };
}
function annotation(text: string, context: Context): Frame | undefined {
  const excluded = new Cursor(text);
  // 只排除圖片裡的測試／範例資料寫入畫面系統；未知否定或其他資料目標不適用。
  if (
    context.fields.size > 0 &&
    excluded.take("不") &&
    excluded.take("將", "把") &&
    excluded.take("圖片", "截圖") &&
    excluded.take("中的", "裡的") &&
    excluded.take("測試", "範例") &&
    excluded.take("資料") &&
    excluded.take("替換", "寫入", "匯入", "套用")
  ) {
    excluded.take("進", "到", "至");
    if (excluded.take("系統") && excluded.done) return { domain: "annotation" };
  }
  const c = new Cursor(text);
  if (c.take("圖片中的", "圖片的")) {
    let count = 0;
    do {
      if (!c.take("寬度標註", "紅框", "箭頭")) return undefined;
      count++;
    } while (count < 3 && c.take("、", "及", "與"));
    c.take("僅");
    if (c.take("作為") && c.take("修改指示") && c.done)
      return { domain: "annotation" };
  }
  if (context.previous?.domain === "annotation") {
    const display = new Cursor(text);
    if (
      display.take("不") &&
      display.take("新增", "加入") &&
      display.take("至", "到") &&
      display.take("看板介面", "畫面", "看板") &&
      display.done
    )
      return { domain: "annotation", annotationDisplay: true };
  }
  return undefined;
}
function presentationText(text: string) {
  const prefix = new RegExp(
    `^(?:請\\s*)?(?:依|按|根據)\\s*(?:本批\\s*)?(?:唯一(?:一張)?(?:的)?\\s*)?(?:(${boardNameToken})(?:的)?看板)?(?:圖片|截圖)(?:的紅框標註|紅框)?`,
    "u",
  );
  const matched = text.match(prefix);
  if (!matched || (matched[1] && !presentationName(matched[1].trim())))
    return text;
  return text.slice(matched[0].length).trim();
}
function frame(text: string, context: Context): Frame | undefined {
  const unchanged = preserve(text, context);
  if (unchanged) return unchanged;
  const s =
    scroll(text, context) ??
    readable(text, context) ??
    annotation(text, context);
  if (s) return s;
  const layout = new Cursor(text);
  const subject = fieldSubject(layout);
  if (subject) {
    const rest = layout.rest;
    const size = width(new Cursor(rest), subject, context);
    if (size) return size;
    if (alignment(new Cursor(rest))) return { domain: "align", ...subject };
    if (subject.defined && uncompressed(new Cursor(rest), subject, context))
      return { domain: "width", ...subject };
    if (layout.done && ["調整", "調寬", "加寬"].includes(subject.command ?? ""))
      return { domain: "width", ...subject };
  }
  const generic = new Cursor(text),
    props = propertyTokens(generic);
  if (
    props.some((p) => ["表頭", "欄頭", "資料列", "列", "儲存格"].includes(p)) &&
    alignment(generic)
  )
    return { domain: "align" };
  if (props.some((p) => ["欄寬", "寬度"].includes(p))) {
    const size = width(generic, undefined, context);
    if (size) return size;
  }
  // 省略主詞的對齊／寬度續句必須有上一個相同呈現域主詞。
  if (
    context.previous &&
    ["width", "align"].includes(context.previous.domain)
  ) {
    const target = new Cursor(text);
    target.match(phone);
    mood(target);
    if (
      target.take("維持", "保持") &&
      target.take("目標欄寬") &&
      target.done &&
      context.previous.label &&
      context.fields.has(context.previous.label) &&
      typeof context.widths.get(context.previous.label) === "number"
    ) {
      return { domain: "width", label: context.previous.label };
    }
    const continuation = new Cursor(text);
    continuation.take("並", "且");
    if (alignment(continuation))
      return { domain: "align", label: context.previous.label };
    const number = new Cursor(text);
    mood(number);
    const actual = number.take("實際");
    const verb = number.take("呈現為", "顯示為", "為");
    if (
      verb &&
      (!(actual || verb !== "為") ||
        (context.previous.label && context.fields.has(context.previous.label)))
    ) {
      const value = widthValue(number, undefined, context);
      if (value && number.done)
        return { domain: "width", label: context.previous.label, ...value };
    }
  }
  return undefined;
}

export function maskUnchangedLoginPresentation(text: string): string {
  const parts = text.split(/([，,。；;\n!?！？])/u);
  const context: Context = { fields: new Set(), widths: new Map() };
  // 只從完整解析的顯式欄位呈現蒐集定義，不從未知句子的片段猜名稱。
  for (let i = 0; i < parts.length; i += 2) {
    for (const segment of presentationText(parts[i].trim()).split(
      /(?:並且|並|且)/u,
    )) {
      const parsed = frame(segment.trim(), { ...context, previous: undefined });
      if (parsed?.label && parsed.defined) context.fields.add(parsed.label);
      if (parsed?.label && parsed.numericWidth !== undefined) {
        const previous = context.widths.get(parsed.label);
        context.widths.set(
          parsed.label,
          previous === undefined || previous === parsed.numericWidth
            ? parsed.numericWidth
            : null,
        );
      }
    }
  }
  const maskedParts = new Map<number, string>();
  let viewportPending = false;
  for (let i = 0; i < parts.length; i += 2) {
    const original = parts[i].trim();
    if (!original) continue;
    const clause = presentationText(original);
    if (!clause) continue;
    const scope = new Cursor(clause);
    if (scope.match(phone) && scope.done) {
      viewportPending = true;
      continue;
    }
    let parsed = frame(clause, context);
    let maskedClause = parsed?.login
      ? clause.replace(/(?:既有|原有)?登入功能/g, "未變更功能")
      : clause;
    // 連接詞只允許連接兩個完整語義，不可把未解析尾巴丟棄。
    if (!parsed && /並|且/u.test(clause)) {
      const segments = clause.split(/(並且|並|且)/u);
      let prior = context.previous;
      for (let j = 0; j < segments.length; j += 2) {
        const segment = segments[j];
        if (j === 0 && !segment.trim() && prior) continue;
        parsed = frame(segment.trim(), { ...context, previous: prior });
        if (!parsed) break;
        if (parsed.login)
          segments[j] = segment.replace(
            /(?:既有|原有)?登入功能/g,
            "未變更功能",
          );
        prior = parsed;
      }
      maskedClause = segments.join("");
    }
    if (
      !parsed ||
      (viewportPending && ["preserve", "annotation"].includes(parsed.domain))
    )
      return text;
    viewportPending = false;
    // 只替換已解析為保留登入的片段；同句其他欄名或引用中的登入文字仍由外層查核。
    if (maskedClause !== clause) {
      const prefix = original.slice(0, original.length - clause.length);
      maskedParts.set(i, parts[i].replace(original, prefix + maskedClause));
    }
    context.previous = parsed;
  }
  if (viewportPending) return text;
  return parts.map((part, i) => maskedParts.get(i) ?? part).join("");
}
