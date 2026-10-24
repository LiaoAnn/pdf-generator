// API refusals in plain Traditional Chinese for the template pages. The upload
// and preview APIs lead each detail message with its issue code
// (`file-missing: …`, `font_not_loaded: …`); the code picks the explanation,
// the detail's file, line, column and JSON path say where, and the raw
// message stays visible for debugging.
import type { ApiError } from '@pdf-generator/contract';

type ErrorBody = ApiError['error'];
type Detail = NonNullable<ErrorBody['details']>[number];

export interface ExplainedIssue {
  /** The code leading the detail message, if it has one. */
  code: string | undefined;
  /** What is wrong and what to do, in plain words. */
  explanation: string;
  /** Where, in words; undefined when the detail doesn't say. */
  location: string | undefined;
  /** The detail message as the API sent it. */
  raw: string;
}

export interface Explanation {
  title: string;
  issues: ExplainedIssue[];
}

/** What checkPack and the upload limits report, by issue code. */
const packIssues: Record<string, string> = {
  'zip-invalid':
    '這個檔案不是可以讀取的 zip。請重新壓縮樣板包資料夾的內容後再上傳。',
  'path-invalid':
    'zip 裡有不合規定的檔案路徑（例如以 / 開頭、含有 .. 或反斜線）。請只放樣板包資料夾裡的相對路徑。',
  'pack-too-large': '樣板包解壓縮後超過 20 MB。請縮小圖片或字型檔再上傳。',
  'pack-too-complex':
    '樣板包的巢狀結構太深，無法檢查。請減少 HTML、JSON 或 Handlebars 區塊的層數。',
  'pack-too-many-files': '樣板包裡的檔案超過 200 個。請刪掉用不到的檔案。',
  'file-too-large':
    '這個文字檔超過 64 KB（樣板、CSS、JSON、SVG 等文字檔各自的上限）。請拆小或精簡內容。',
  'pack-text-too-large':
    '樣板包所有文字檔加起來超過 256 KB。請精簡樣板、CSS 或範例資料。',
  'pack-check-failed':
    '檢查樣板包時發生預期外的錯誤，平台無法判斷它是否正確。請把原始訊息提供給平台維護者。',
  'manifest-missing':
    '最上層找不到 manifest.json。請壓縮樣板包資料夾「裡面」的檔案，而不是整個資料夾。',
  'manifest-invalid':
    'manifest.json 的內容不符合規格（例如缺少欄位、值不在允許範圍內）。請照位置修正這個欄位。',
  'file-missing':
    'manifest.json 列出了這個檔案，但樣板包裡沒有。請補上檔案或修正路徑。',
  'file-unlisted':
    '樣板包裡有這個檔案，但 manifest.json 沒有列出。請把它加進 manifest，或從樣板包刪掉。',
  'text-encoding': '這個檔案不是 UTF-8 文字。請用 UTF-8 編碼另存後再上傳。',
  'json-syntax':
    '這個 JSON 檔有語法錯誤（例如多了逗號、少了引號或括號）。請在指出的位置修正。',
  'rules-invalid':
    '假資料規則（rules）不符合規格，例如欄位類型不存在或範圍顛倒。請照位置修正這條規則。',
  'sample-invalid':
    '範例資料（sample）不符合假資料規則，例如格式或檢查碼不對、數值超出範圍。請照位置修正範例資料。',
  'template-syntax':
    '樣板的 Handlebars 語法有錯，例如 {{#if}} 沒有對應的 {{/if}}。請在指出的位置修正。',
  'template-render':
    '用範例資料填入樣板時出錯，例如 {{#each}} 用在不是清單的欄位上。請檢查這個位置用到的資料。',
  'template-structure':
    '這個 Handlebars 標記把 HTML 標籤或屬性切斷了。請讓 {{…}} 區塊包住完整的元素。',
  'template-unknown-field':
    '樣板用到一個資料裡沒有的欄位，常見原因是拼錯字。請對照假資料規則的欄位名稱。',
  'template-unsupported':
    '樣板用到平台不支援的 Handlebars 寫法（例如 {{{ }}}、partial 或自訂 helper）。請改用支援的寫法。',
  'html-active':
    '樣板裡有會執行程式或自動跳轉的內容（例如 <script>、onclick、meta refresh）。樣板包不能帶程式，請移除。',
  'html-unsupported':
    '樣板用到列印文件不需要的 HTML 元素或屬性。請改用一般的版面元素。',
  'gt-unmarked':
    '這段會印出來的內容沒有標上 data-gt，標準答案會漏掉它。請把它放進有 data-gt 的元素裡。',
  'gt-type':
    'data-gt 的區塊類型不存在。請改成規格書列出的類型（例如 title、paragraph、table）。',
  'gt-nested':
    '有 data-gt 的元素裡面又有 data-gt。區塊不能巢狀，請只留外層或內層其中一個。',
  'gt-id': 'data-gt-id 是空的。請填入名稱，或拿掉這個屬性。',
  'gt-attribute':
    '這個 data-gt-* 屬性的值不合規定，或用在不適合的元素上。請照規格書修正。',
  'gt-branch':
    'data-gt 屬性橫跨了 {{#if}} 的分支，兩個分支印出來的標記會不一致。請讓每個分支各自標好完整的元素。',
  'gt-checkbox':
    '勾選框區塊的寫法不對，平台讀不出它有沒有勾。請照規格書的勾選框寫法標記。',
  'gt-formula':
    '公式區塊缺少 LaTeX（data-gt-latex）或寫法不對。請照規格書標記公式。',
  'gt-image-text':
    '圖片內文字（data-gt-text）的寫法不對。請照規格書標記圖片裡的文字。',
  'gt-table':
    '表格區塊的結構不符合規格（例如列、欄或合併儲存格的寫法）。請照規格書修正表格。',
  'asset-external':
    '樣板或 CSS 引用了樣板包外面的網址。列印時不能連網，請把檔案放進樣板包並改用相對路徑。',
  'asset-path':
    '這個路徑指到樣板包外面（例如以 / 開頭或用 .. 跳出）。請改成從這個檔案出發的相對路徑。',
  'asset-missing':
    '樣板或 CSS 引用的檔案不在樣板包裡。請補上檔案，或修正路徑的大小寫與拼字。',
  'asset-data':
    '樣板引用了 data: 網址的內容。請把檔案放進樣板包，用相對路徑引用。',
  'asset-dynamic':
    '檔案路徑是用 Handlebars 動態組出來的，平台無法確認檔案存在。請改用固定的路徑。',
  'css-escape':
    'CSS 裡有反斜線跳脫字元，平台無法確認它引用的檔案。請改成不用跳脫的寫法。',
  'font-unused':
    '宣告了 @font-face 卻沒有任何地方用到這個字型。列印時仍會下載它，請刪掉宣告或在 font-family 用它。',
};

/** What the print Worker reports when it can't print the sample. */
const printIssues: Record<string, string> = {
  font_not_loaded:
    '列印時有字型載入失敗：可能是字型檔損壞或路徑錯誤，或列印服務還不支援樣板包自帶的字型。請先改用平台內建的中文字型試試。',
  pagination_timeout:
    '分頁花太久，列印逾時。請檢查是否有極長的表格或無法分頁的大區塊。',
  row_fragmented:
    '有表格列被切在兩頁之間。請讓每一列的高度小於一頁，或允許表格在列與列之間換頁。',
  text_missing:
    '印出來的 PDF 少了一些文字，通常是字型缺字。請改用平台內建的中文字型，或檢查特殊符號。',
};

const fallback =
  '這是平台還沒有中文說明的問題。請看下方的原始訊息；需要協助時把它提供給平台維護者。';

const titles: Record<string, string> = {
  preview_failed: '範例印不出來',
  print_unavailable: '列印服務暫時無法使用，請稍後再試',
  template_not_found: '找不到這個樣板或版本',
  unauthenticated: '請先登入',
};

/** `files.styles[0]`, `rows[2].amount`, `[0].a` */
function field(path: (string | number)[]): string {
  return path
    .map((key, i) =>
      typeof key === 'number' ? `[${key}]` : i === 0 ? key : `.${key}`,
    )
    .join('');
}

function location(detail: Detail, code: string | undefined) {
  const parts: string[] = [];
  if (detail.file !== undefined) {
    let place = detail.file;
    if (detail.line !== undefined) {
      place += ` 第 ${detail.line} 行`;
      if (detail.column !== undefined) place += `第 ${detail.column} 欄`;
    }
    parts.push(place);
  }
  if (detail.path !== undefined && detail.path.length > 0) {
    parts.push(`欄位 ${field(detail.path)}`);
  }
  if (parts.length > 0) return parts.join('，');
  return code !== undefined && code in packIssues ? '整個樣板包' : undefined;
}

function explainDetail(detail: Detail): ExplainedIssue {
  const code = /^([a-z][a-z0-9_-]*): /.exec(detail.message)?.[1];
  return {
    code,
    explanation:
      (code !== undefined && (packIssues[code] ?? printIssues[code])) ||
      fallback,
    location: location(detail, code),
    raw: detail.message,
  };
}

/** A refusal from the template API, explained. */
export function explainError(error: ErrorBody): Explanation {
  const issues = (error.details ?? []).map(explainDetail);
  if (error.code === 'invalid_template_pack') {
    return {
      title: `樣板包沒有通過檢查，共 ${issues.length} 個問題`,
      issues,
    };
  }
  if (error.code === 'template_pack_too_large') {
    return {
      title: '檔案太大，沒有上傳',
      issues: [
        {
          code: undefined,
          explanation:
            '上傳的 zip 不能超過 10 MB。請縮小圖片或字型檔，或刪掉用不到的檔案後再上傳。',
          location: undefined,
          raw: `${error.code}: ${error.message}`,
        },
      ],
    };
  }
  return { title: titles[error.code] ?? '操作沒有完成', issues };
}
