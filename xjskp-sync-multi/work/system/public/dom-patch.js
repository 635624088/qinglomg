export function setTextIfChanged(node, nextValue) {
  return setStringPropertyIfChanged(node, "textContent", nextValue);
}

export function setValueIfChanged(control, nextValue) {
  return setStringPropertyIfChanged(control, "value", nextValue);
}

export function setBooleanPropertyIfChanged(node, propertyName, nextValue) {
  const normalizedValue = Boolean(nextValue);
  if (node[propertyName] === normalizedValue) return false;
  node[propertyName] = normalizedValue;
  return true;
}

export function setAttributeIfChanged(node, name, nextValue) {
  const currentValue = node.getAttribute(name);
  if (nextValue === null || nextValue === undefined) {
    if (currentValue === null) return false;
    node.removeAttribute(name);
    return true;
  }

  const normalizedValue = String(nextValue);
  if (currentValue === normalizedValue) return false;
  node.setAttribute(name, normalizedValue);
  return true;
}

export function toggleClassIfChanged(node, className, enabled) {
  const normalizedState = Boolean(enabled);
  if (node.classList.contains(className) === normalizedState) return false;
  node.classList.toggle(className, normalizedState);
  return true;
}

function setStringPropertyIfChanged(node, propertyName, nextValue) {
  const normalizedValue = String(nextValue ?? "");
  if (node[propertyName] === normalizedValue) return false;
  node[propertyName] = normalizedValue;
  return true;
}
