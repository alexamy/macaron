import { PluginState, ProgramScope } from '../types';
import { NodePath, types as t } from '@babel/core';
import { Binding } from '@babel/traverse';
import {
  extractionAPIs,
  getNearestIdentifier,
  registerImportMethod,
} from '../utils';

export function transformCallExpression(
  callPath: NodePath<t.CallExpression>,
  _callState: PluginState
) {
  if (
    !extractionAPIs.some(api =>
      callPath.get('callee').referencesImport('@macaron-css/core', api)
    )
  ) {
    return;
  }

  const programParent = callPath.scope.getProgramParent() as ProgramScope;

  if (callPath.parentPath.isVariableDeclarator()) {
    const variablePath = callPath.parentPath;
    const shouldReExport =
      variablePath.parentPath.parentPath?.isExportNamedDeclaration() ?? false;
    const ident = variablePath.get('id') as NodePath<t.Node>;

    if (!ident.isArrayPattern() && !ident.isIdentifier()) {
      throw new Error(
        'Declaration should be an `ArrayPattern` or `Identifier`'
      );
    }

    let styleToPush: Exclude<
      ProgramScope['macaronData']['nodes'][number],
      { type: 'binding' }
    >;

    if (ident.isArrayPattern()) {
      for (const elementPath of ident.get('elements')) {
        if (elementPath.isIdentifier()) {
          const programUniqueIdent = programParent.generateUidIdentifier(
            elementPath.node.name
          );

          const importedIdent = registerImportMethod(
            variablePath,
            programUniqueIdent.name,
            programParent.macaronData.cssFile
          );

          variablePath.scope.rename(
            elementPath.node.name,
            programUniqueIdent.name
          );

          // this happening on each array pattern element means
          // that multiple declarations get written to in the virtual file
          // but it shouldn't matter much since they get tree shaked by the bundler
          // and new identifiers are created for each, so it shouldn't cause violations
          styleToPush = {
            type: 'style',
            shouldReExport,
            export: t.exportNamedDeclaration(
              t.variableDeclaration('var', [t.cloneNode(variablePath.node)])
            ),
            name: programUniqueIdent.name,
          };

          variablePath.scope.rename(
            programUniqueIdent.name,
            importedIdent.name
          );
        }
      }
    } else {
      const programUniqueIdent = programParent.generateUidIdentifier(
        ident.node.name
      );

      variablePath.scope.rename(ident.node.name, programUniqueIdent.name);

      const importedIdent = registerImportMethod(
        variablePath,
        programUniqueIdent.name,
        programParent.macaronData.cssFile
      );

      styleToPush = {
        type: 'style',
        shouldReExport,
        export: t.exportNamedDeclaration(
          t.variableDeclaration('var', [t.cloneNode(variablePath.node)])
        ),
        name: programUniqueIdent.name,
      };

      variablePath.scope.rename(programUniqueIdent.name, importedIdent.name);
    }

    const allBindings = variablePath.scope.getAllBindings() as Record<
      string,
      Binding
    >;

    let shouldPush = false;
    let alreadyPushed = false;
    const pushStyle = () => {
      if (shouldPush && !alreadyPushed) {
        programParent.macaronData.nodes.push(styleToPush);
        alreadyPushed = true;
      }

      shouldPush = true;
      // pushedStyle = true;
    };

    for (const bindingName in allBindings) {
      const binding = allBindings[bindingName];
      if (binding && bindingName) {
        const bindingNode = findRootBinding(binding.path);
        const bindingLoc = bindingNode.loc;
        const callLoc = callPath.node.loc;

        const pushBinding = () => {
          if (
            programParent.macaronData.bindings.includes(binding.path) ||
            !binding.referenced
          )
            return;

          programParent.macaronData.nodes.push({
            type: 'binding',
            node: t.cloneNode(bindingNode),
          });
          programParent.macaronData.bindings.push(binding.path);
        };

        if (programParent.macaronData.bindings.includes(binding.path)) {
          pushStyle();

          continue;
        }

        if (bindingLoc == null || callLoc == null) {
          pushBinding();
          pushStyle();

          continue;
        }

        if (
          bindingLoc.end.line < callLoc.start.line ||
          (bindingLoc.start.line < callLoc.start.line &&
            bindingLoc.end.line > callLoc.end.line) ||
          (bindingLoc.start.line === callLoc.start.line &&
            bindingLoc.start.column < callLoc.start.column)
        ) {
          shouldPush = false;
          pushBinding();
          pushStyle();
        } else {
          shouldPush = true;
          pushBinding();
          pushStyle();
        }
      }
    }

    shouldPush = true;
    pushStyle();

    variablePath.remove();

    return;
  }

  const nearestIdentifier = getNearestIdentifier(callPath);
  const ident = nearestIdentifier
    ? programParent.generateUidIdentifier(
        `$$macaron_${nearestIdentifier.node.name}`
      )
    : programParent.generateUidIdentifier('$$unknown_macaron_identifier');
  const importedIdent = registerImportMethod(
    callPath,
    ident.name,
    programParent.macaronData.cssFile
  );

  const declaration = t.exportNamedDeclaration(
    t.variableDeclaration('var', [
      t.variableDeclarator(ident, t.cloneNode(callPath.node)),
    ])
  );

  const allBindings = callPath.scope.getAllBindings() as Record<
    string,
    Binding
  >;

  // let pushedStyle = false;
  let shouldPush = false;
  let alreadyPushed = false;
  const pushStyle = () => {
    if (shouldPush && !alreadyPushed) {
      programParent.macaronData.nodes.push({
        type: 'style',
        export: declaration,
        name: ident.name,
        shouldReExport: false,
      });

      alreadyPushed = true;
    }

    shouldPush = true;
    // pushedStyle = true;
  };

  for (const bindingName in allBindings) {
    const binding = allBindings[bindingName];
    if (binding && bindingName) {
      const bindingNode = findRootBinding(binding.path);
      const bindingLoc = bindingNode.loc;
      const callLoc = callPath.node.loc;

      const pushBinding = () => {
        if (programParent.macaronData.bindings.includes(binding.path)) return;

        programParent.macaronData.nodes.push({
          type: 'binding',
          node: t.cloneNode(bindingNode),
        });
        programParent.macaronData.bindings.push(binding.path);
      };

      if (programParent.macaronData.bindings.includes(binding.path)) {
        pushStyle();

        continue;
      }

      if (bindingLoc == null || callLoc == null) {
        pushBinding();
        pushStyle();

        continue;
      }

      if (
        bindingLoc.end.line < callLoc.start.line ||
        (bindingLoc.start.line < callLoc.start.line &&
          bindingLoc.end.line > callLoc.end.line) ||
        (bindingLoc.start.line === callLoc.start.line &&
          bindingLoc.start.column < callLoc.start.column)
      ) {
        shouldPush = false;
        pushBinding();
        pushStyle();
      } else {
        shouldPush = true;
        pushBinding();
        pushStyle();
      }
    }
  }

  shouldPush = true;
  pushStyle();

  callPath.replaceWith(importedIdent);
}

function findRootBinding(path: NodePath<t.Node>) {
  let node: t.Node;
  if (!('parent' in path) || path.parentPath?.isProgram()) {
    node = path.node as any;
  } else {
    node = path.parent as any;
  }

  return t.cloneNode(node);
}