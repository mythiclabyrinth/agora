const STORYBOOK_ENV = "EXPO_PUBLIC_STORYBOOK_ENABLED";
const STORYBOOK_ONLY = require("../storybook-native-dependencies") as string[];

function loadConfig(enabled?: string) {
  jest.resetModules();
  if (enabled === undefined) delete process.env[STORYBOOK_ENV];
  else process.env[STORYBOOK_ENV] = enabled;
  return require("../react-native.config.js") as {
    dependencies: Record<string, { platforms: { android: null; ios: null } }>;
  };
}

afterEach(() => {
  delete process.env[STORYBOOK_ENV];
  jest.resetModules();
});

test("production excludes every Storybook-only native module", () => {
  const config = loadConfig();
  expect(Object.keys(config.dependencies).sort()).toEqual([...STORYBOOK_ONLY].sort());
  for (const name of STORYBOOK_ONLY) {
    expect(config.dependencies[name]).toEqual({
      platforms: { android: null, ios: null },
    });
  }
});

test("production autolinks the native modules the app imports", () => {
  const config = loadConfig();
  for (const name of ["react-native-gesture-handler", "react-native-reanimated", "react-native-worklets"]) {
    expect(config.dependencies[name]).toBeUndefined();
  }
});

test("Storybook builds allow its native modules to autolink", () => {
  expect(loadConfig("true").dependencies).toEqual({});
});
