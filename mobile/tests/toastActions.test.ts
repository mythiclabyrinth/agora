import { toastAction, useToasts } from "../src/components/Toast";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

beforeEach(() => {
  jest.useFakeTimers();
  useToasts.setState({ items: [] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it("keeps a separate Undo callback for each identical action toast", () => {
  const undoFirst = jest.fn();
  const undoSecond = jest.fn();
  toastAction("Thread removed from Inbox", "Undo", undoFirst);
  toastAction("Thread removed from Inbox", "Undo", undoSecond);

  const items = useToasts.getState().items;
  expect(items).toHaveLength(2);
  items[0].action?.onPress();
  items[1].action?.onPress();
  expect(undoFirst).toHaveBeenCalledTimes(1);
  expect(undoSecond).toHaveBeenCalledTimes(1);
});
