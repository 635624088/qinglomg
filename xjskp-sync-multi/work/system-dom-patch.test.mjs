import assert from "node:assert/strict";
import test from "node:test";

const domPatchModule = await import("./system/public/dom-patch.js").catch(() => ({}));
const {
  setAttributeIfChanged,
  setBooleanPropertyIfChanged,
  setTextIfChanged,
  setValueIfChanged,
  toggleClassIfChanged,
} = domPatchModule;

test("dom patch module exposes the frozen T1 API", () => {
  for (const fn of [
    setAttributeIfChanged,
    setBooleanPropertyIfChanged,
    setTextIfChanged,
    setValueIfChanged,
    toggleClassIfChanged,
  ]) {
    assert.equal(typeof fn, "function");
  }
});

test("text patch skips equal values and writes dynamic text without innerHTML", () => {
  const node = createTrackedNode("status", { textContent: "正常" });

  assert.equal(setTextIfChanged(node, "正常"), false);
  assert.deepEqual(node.writes, []);

  const dynamicText = '<img src=x onerror="alert(1)"><script>bad()</script>';
  assert.equal(setTextIfChanged(node, dynamicText), true);
  assert.equal(node.textContent, dynamicText);
  assert.deepEqual(node.writes, [{
    target: "status",
    kind: "property",
    name: "textContent",
    value: dynamicText,
  }]);

  assert.equal(setTextIfChanged(node, dynamicText), false);
  assert.equal(node.writes.length, 1);
});

test("text and form values normalize nullish values and numbers before comparing", () => {
  const textNode = createTrackedNode("count", { textContent: "4" });
  const input = createTrackedNode("threshold", { value: "0.50" });

  assert.equal(setTextIfChanged(textNode, 4), false);
  assert.equal(setValueIfChanged(input, "0.50"), false);
  assert.equal(setTextIfChanged(textNode, null), true);
  assert.equal(setValueIfChanged(input, undefined), true);
  assert.equal(textNode.textContent, "");
  assert.equal(input.value, "");
  assert.equal(textNode.writes.length, 1);
  assert.equal(input.writes.length, 1);
});

test("boolean property patch is idempotent for hidden disabled and checked", () => {
  for (const propertyName of ["hidden", "disabled", "checked"]) {
    const node = createTrackedNode(propertyName, { [propertyName]: false });

    assert.equal(setBooleanPropertyIfChanged(node, propertyName, false), false);
    assert.equal(setBooleanPropertyIfChanged(node, propertyName, true), true);
    assert.equal(setBooleanPropertyIfChanged(node, propertyName, true), false);
    assert.equal(setBooleanPropertyIfChanged(node, propertyName, false), true);
    assert.deepEqual(node.writes.map((write) => write.value), [true, false]);
  }
});

test("attribute patch compares raw values and only removes an existing attribute", () => {
  const node = createTrackedNode("link", {
    attributes: {
      href: "./outputs/detail.html",
      title: "查看详情",
      "data-state": "ready",
    },
  });

  assert.equal(setAttributeIfChanged(node, "href", "./outputs/detail.html"), false);
  assert.equal(setAttributeIfChanged(node, "title", "查看详情"), false);
  assert.equal(setAttributeIfChanged(node, "aria-selected", false), true);
  assert.equal(node.getAttribute("aria-selected"), "false");
  assert.equal(setAttributeIfChanged(node, "href", "./outputs/new.html"), true);
  assert.equal(setAttributeIfChanged(node, "data-state", null), true);
  assert.equal(setAttributeIfChanged(node, "data-state", undefined), false);
  assert.deepEqual(node.writes, [
    {
      target: "link",
      kind: "attribute-set",
      name: "aria-selected",
      value: "false",
    },
    {
      target: "link",
      kind: "attribute-set",
      name: "href",
      value: "./outputs/new.html",
    },
    {
      target: "link",
      kind: "attribute-remove",
      name: "data-state",
      value: null,
    },
  ]);
});

test("class patch only toggles when the requested state changes", () => {
  const node = createTrackedNode("card", { classes: ["active"] });

  assert.equal(toggleClassIfChanged(node, "active", true), false);
  assert.equal(toggleClassIfChanged(node, "pending", true), true);
  assert.equal(toggleClassIfChanged(node, "pending", true), false);
  assert.equal(toggleClassIfChanged(node, "active", false), true);
  assert.deepEqual(node.writes, [
    {
      target: "card",
      kind: "class-toggle",
      name: "pending",
      value: true,
    },
    {
      target: "card",
      kind: "class-toggle",
      name: "active",
      value: false,
    },
  ]);
});

test("changing one value only writes the selected target node", () => {
  const period = createTrackedNode("period", { textContent: "12" });
  const step = createTrackedNode("step", { textContent: "检查订单" });

  assert.equal(setTextIfChanged(period, "13"), true);
  assert.equal(setTextIfChanged(step, "检查订单"), false);
  assert.equal(setValueIfChanged(period, ""), false);
  assert.deepEqual(period.writes, [{
    target: "period",
    kind: "property",
    name: "textContent",
    value: "13",
  }]);
  assert.deepEqual(step.writes, []);
});

function createTrackedNode(target, initial = {}) {
  const values = {
    textContent: String(initial.textContent ?? ""),
    value: String(initial.value ?? ""),
    hidden: Boolean(initial.hidden),
    disabled: Boolean(initial.disabled),
    checked: Boolean(initial.checked),
  };
  const attributes = new Map(
    Object.entries(initial.attributes || {}).map(([name, value]) => [name, String(value)]),
  );
  const classes = new Set(initial.classes || []);
  const writes = [];
  const node = {
    writes,
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, value) {
      const normalizedValue = String(value);
      attributes.set(name, normalizedValue);
      writes.push({
        target,
        kind: "attribute-set",
        name,
        value: normalizedValue,
      });
    },
    removeAttribute(name) {
      attributes.delete(name);
      writes.push({
        target,
        kind: "attribute-remove",
        name,
        value: null,
      });
    },
    classList: {
      contains(name) {
        return classes.has(name);
      },
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
        writes.push({
          target,
          kind: "class-toggle",
          name,
          value: Boolean(enabled),
        });
      },
    },
  };

  for (const propertyName of ["textContent", "value", "hidden", "disabled", "checked"]) {
    Object.defineProperty(node, propertyName, {
      enumerable: true,
      get() {
        return values[propertyName];
      },
      set(value) {
        values[propertyName] = value;
        writes.push({
          target,
          kind: "property",
          name: propertyName,
          value,
        });
      },
    });
  }

  Object.defineProperty(node, "innerHTML", {
    enumerable: true,
    get() {
      return "";
    },
    set() {
      throw new Error("T1 text updates must not use innerHTML");
    },
  });

  return node;
}
