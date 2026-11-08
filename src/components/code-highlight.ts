// Loaded on demand as its own chunk, so replies without code never download a grammar.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, c, cpp, css, diff, go, ini, java, javascript, json, kotlin, markdown, php, python, ruby, rust, shell, sql, swift, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}
// Fences name the shell many ways; commands read better with the Bash grammar than as a console session.
hljs.registerAliases(["sh", "zsh", "terminal"], { languageName: "bash" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });

/** Larger blocks stay plain, so one long paste cannot stall typing in the composer. */
const MAX_LENGTH = 100_000;
const results = new Map<string, string>();
/**
 * The block as highlighted HTML, or null for a language not registered here. highlight.js escapes
 * the code itself, so the result is safe to set as markup.
 */
export function highlight(code: string, language: string): string | null {
  const name = language.toLowerCase();
  if (code.length > MAX_LENGTH || !hljs.getLanguage(name)) return null;
  const key = `${name}\n${code}`;
  let html = results.get(key);
  if (html === undefined) {
    html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    // Recently shown blocks stay ready, so a transcript that remounts paints them highlighted.
    if (results.size >= 200) results.delete(results.keys().next().value!);
    results.set(key, html);
  }
  return html;
}
