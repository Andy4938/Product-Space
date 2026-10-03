import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// App imports Leaflet, which requires a browser DOM. Inspect JSX structure with the
// TypeScript parser while the browser QA covers actual rendered interactions.
const source = ts.createSourceFile(
  'App.tsx', readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

function component(name: string): ts.FunctionDeclaration {
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, `${name} must remain defined`);
  return declaration;
}

function elements(root: ts.Node, tag: string): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const found: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === tag) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

test('student has one emergency home, without a second map or alternate hold control', () => {
  const student = component('StudentApp');
  assert.ok(elements(student, 'EmergencyHold').length > 0);
  assert.equal(elements(student, 'SessionMap').length, 0);
  assert.equal(elements(student, 'HoldToCheckIn').length, 0);
  assert.ok(elements(component('GuardianApp'), 'SessionMap').length > 0);
});

test('student guardian sharing opens only as a private dialog', () => {
  const shares = elements(component('StudentApp'), 'GuardianShare');
  assert.ok(shares.length > 0);
  for (const share of shares) {
    const variant = share.attributes.properties.find(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'variant');
    assert.ok(variant && ts.isJsxAttribute(variant) && variant.initializer && ts.isStringLiteral(variant.initializer));
    assert.equal(variant.initializer.text, 'dialog');
  }
});

test('the app routes guardian links to the guardian surface', () => {
  const app = component('App');
  assert.ok(elements(app, 'GuardianApp').length > 0);
  assert.ok(elements(app, 'StudentApp').length > 0);
});

test('guardian puts location freshness before optional notification setup', () => {
  const sections = elements(component('GuardianApp'), 'section');
  const byClass = (className: string) => sections.find(section => section.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'className' &&
    attribute.initializer && ts.isStringLiteral(attribute.initializer) &&
    attribute.initializer.text.split(' ').includes(className)));
  const map = byClass('watch-map-card');
  const notifications = byClass('notify-card');
  assert.ok(map, 'guardian must show the map and its freshness status');
  assert.ok(notifications, 'guardian must retain optional notification setup');
  assert.ok(map.pos < notifications.pos, 'map and freshness status should precede optional notifications');
});
