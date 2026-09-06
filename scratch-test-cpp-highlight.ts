import { parseAgentMarkdown } from "./src/tui/format";

const md = "Here is the loop:\n\n```cpp\nclass Foo {\n  int bar() { return 42; }\n};\n```\n";

const lines = parseAgentMarkdown(md);
for (const l of lines) {
  console.log(JSON.stringify(l));
}
