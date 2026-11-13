// Colours for code in replies, one line at a time and with no grammar: strings, comments,
// numbers and common keywords. It is deliberately rough; a string or comment that spans
// lines is only coloured on its first.
import type { Paint } from "./ui.ts";

const C_LIKE = new Set(["js", "jsx", "ts", "tsx", "javascript", "typescript", "java", "c", "cpp", "h", "go", "rust", "rs", "swift", "kotlin", "cs", "php", "json", "css"]);
const HASH = new Set(["py", "python", "sh", "bash", "zsh", "shell", "yaml", "yml", "toml", "rb", "ruby", "dockerfile", "makefile"]);
const KEYWORDS =
  "abstract as async await break case catch class const continue def default defer del do elif else enum except export extends false final finally fn for from func function if impl implements import in interface is lambda let match mod new nil none not null of or package pass private protected pub public raise return self static struct super switch then this throw trait true try type typeof undefined use var void while with yield";
const WORD = new RegExp(`^(?:${KEYWORDS.split(" ").join("|")})$`, "i");

export function highlight(line: string, lang: string, p: Paint): string {
  const l = lang.toLowerCase();
  const comment = C_LIKE.has(l) ? "\\/\\/.*$" : HASH.has(l) ? "#.*$" : null;
  const parts = [comment ?? "(?!)", `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\``, "\\b\\d+(?:\\.\\d+)?\\b", "\\b[A-Za-z_]\\w*\\b"];
  const re = new RegExp(parts.map((x) => `(${x})`).join("|"), "g");
  return line.replace(re, (all, isComment, isString, isNumber, isWord) => {
    if (isComment) return p.dim(all);
    if (isString) return p.green(all);
    if (isNumber) return p.yellow(all);
    return isWord && WORD.test(all) && (comment !== null || l === "") ? p.cyan(all) : all;
  });
}
