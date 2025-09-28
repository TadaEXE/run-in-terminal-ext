import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import postcss from "rollup-plugin-postcss";

export default {
  input: "src/terminal.entry.js",
  output: { file: "pages/assets/terminal.js", format: "esm", sourcemap: false },
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    postcss({
      inject: true,     // ⬅️ embed CSS into JS and auto-insert <style>
      extract: false,   // ⬅️ do NOT emit a separate CSS file
      minimize: false,
      sourceMap: false
    })
  ],
  treeshake: true
};

