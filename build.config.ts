import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      minify: true,
      // Bundled third-party licenses (oxc) are included in LICENSE
      license: false,
      input: ["./src/index.ts"],
    },
  ],
  hooks: {
    // Worker threads import the module that spawns them (`import.meta.url`): keep the host
    // in its own chunk so workers skip parsing the entry that embeds the wasm
    rolldownOutput(config) {
      const { groups } = config.codeSplitting as { groups: object[] };
      groups.unshift({ name: "napi", test: /\/src\/(napi|worker_threads)\.ts$/ });
    },
  },
});
