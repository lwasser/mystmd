import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import type { TemplateImports } from 'jtex';
import { mergeTemplateImports } from 'jtex';
import { tic, writeFileToFolder } from 'myst-cli-utils';
import type { GenericParent, References } from 'myst-common';
import { extractPart, TemplateKind } from 'myst-common';
import type { PageFrontmatter } from 'myst-frontmatter';
import { ExportFormats } from 'myst-frontmatter';
import type { TemplatePartDefinition, TemplateYml } from 'myst-templates';
import MystTemplate from 'myst-templates';
import mystToTypst from 'myst-to-typst';
import type { TypstResult } from 'myst-to-typst';
import type { LinkTransformer } from 'myst-transforms';
import { unified } from 'unified';
import { findCurrentProjectAndLoad } from '../../config.js';
import { loadProjectFromDisk } from '../../project/index.js';
import { castSession } from '../../session/index.js';
import type { ISession } from '../../session/types.js';
import { createTempFolder, ImageExtensions, logMessagesFromVFile } from '../../utils/index.js';
import type { ExportWithOutput, ExportOptions, ExportResults } from '../types.js';
import {
  cleanOutput,
  collectTexExportOptions,
  getFileContent,
  resolveAndLogErrors,
} from '../utils/index.js';
import version from '../../version.js';

export const DEFAULT_BIB_FILENAME = 'main.bib';
const TYPST_IMAGE_EXTENSIONS = [
  ImageExtensions.pdf,
  ImageExtensions.png,
  ImageExtensions.jpg,
  ImageExtensions.jpeg,
];

export function mdastToTypst(
  session: ISession,
  mdast: GenericParent,
  references: References,
  frontmatter: PageFrontmatter,
  templateYml: TemplateYml | null,
) {
  const pipe = unified().use(mystToTypst, {
    math: frontmatter?.math,
    // citestyle: templateYml?.style?.citation,
    // bibliography: templateYml?.style?.bibliography,
    // references,
  });
  const result = pipe.runSync(mdast as any);
  const tex = pipe.stringify(result);
  logMessagesFromVFile(session, tex);
  return tex.result as TypstResult;
}

export function extractTexPart(
  session: ISession,
  mdast: GenericParent,
  references: References,
  partDefinition: TemplatePartDefinition,
  frontmatter: PageFrontmatter,
  templateYml: TemplateYml,
): TypstResult | undefined {
  const part = extractPart(mdast, partDefinition.id);
  if (!part) return undefined;
  const partContent = mdastToTypst(session, part, references, frontmatter, templateYml);
  return partContent;
}

export async function localArticleToTexRaw(
  session: ISession,
  templateOptions: ExportWithOutput,
  projectPath?: string,
  extraLinkTransformers?: LinkTransformer[],
): Promise<ExportResults> {
  const { article, output } = templateOptions;
  const [{ mdast, frontmatter, references }] = await getFileContent(
    session,
    [article],
    path.join(path.dirname(output), 'files'),
    {
      projectPath,
      imageAltOutputFolder: 'files/',
      imageExtensions: TYPST_IMAGE_EXTENSIONS,
      extraLinkTransformers,
      simplifyFigures: true,
    },
  );
  const toc = tic();
  const result = mdastToTypst(session, mdast, references, frontmatter, null);
  session.log.info(toc(`📑 Exported TeX in %s, copying to ${output}`));
  // TODO: add imports and macros?
  writeFileToFolder(output, result.value);
  return { tempFolders: [] };
}

function writeBibtexFromCitationRenderers(session: ISession, output: string) {
  const cache = castSession(session);
  const allBibtexContent = Object.values(cache.$citationRenderers)
    .map((renderers) => {
      return Object.values(renderers).map((renderer) => {
        const bibtexContent = (renderer.cite._graph as any[]).find((item) => {
          return item.type === '@biblatex/text';
        });
        return bibtexContent?.data;
      });
    })
    .flat()
    .filter((item) => !!item);
  const bibtexContent = [...new Set(allBibtexContent)].join('\n');
  if (!fs.existsSync(output)) fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bibtexContent);
}

export async function localArticleToTexTemplated(
  session: ISession,
  file: string,
  templateOptions: ExportWithOutput,
  projectPath?: string,
  force?: boolean,
  extraLinkTransformers?: LinkTransformer[],
): Promise<ExportResults> {
  const filesPath = path.join(path.dirname(templateOptions.output), 'files');
  const [{ frontmatter, mdast, references }] = await getFileContent(
    session,
    [templateOptions.article],
    filesPath,
    {
      projectPath,
      imageAltOutputFolder: 'files/',
      imageExtensions: TYPST_IMAGE_EXTENSIONS,
      extraLinkTransformers,
      simplifyFigures: true,
    },
  );
  writeBibtexFromCitationRenderers(
    session,
    path.join(path.dirname(templateOptions.output), DEFAULT_BIB_FILENAME),
  );

  const mystTemplate = new MystTemplate(session, {
    kind: TemplateKind.tex,
    template: templateOptions.template || undefined,
    buildDir: session.buildPath(),
  });
  await mystTemplate.ensureTemplateExistsOnPath();
  const toc = tic();
  const templateYml = mystTemplate.getValidatedTemplateYml();

  const partDefinitions = templateYml?.parts || [];
  const parts: Record<string, string> = {};
  let collectedImports: TemplateImports = { imports: [], commands: {} };
  partDefinitions.forEach((def) => {
    const result = extractTexPart(session, mdast, references, def, frontmatter, templateYml);
    if (result != null) {
      collectedImports = mergeTemplateImports(collectedImports, result);
      parts[def.id] = result?.value ?? '';
    }
  });

  // prune mdast based on tags, if required by template, eg abstract, acknowledgements
  // Need to load up template yaml - returned from jtex, with 'parts' dict
  // This probably means we need to store tags alongside oxa link for blocks
  // This will need opts eventually --v
  const result = mdastToTypst(session, mdast, references, frontmatter, templateYml);
  // Fill in template
  session.log.info(toc(`📑 Exported typst in %s, copying to ${templateOptions.output}`));
  // Have a better template!
  const importStatements: string[] = [];
  if (result.macros.length > 0) {
    const mystTypst = path.join(path.dirname(templateOptions.output), 'myst.typ');
    importStatements.push('#import "myst.typ": *');
    writeFileToFolder(mystTypst, result.macros.join('\n\n'));
  }
  importStatements.push('#set math.equation(numbering: "(1)")');
  if (Object.keys(result.commands).length > 0) {
    importStatements.push('', '/* Math Macros */');
    Object.entries(result.commands).forEach(([k, v]) => {
      // Won't work for math with args
      importStatements.push(`#let ${k} = $${v.trim()}$`);
    });
  }
  const bib = `


#show bibliography: set text(8pt)
#bibliography("${DEFAULT_BIB_FILENAME}", title: text(10pt)[References], style: "ieee")`;
  const typst = `/* Written by MyST v${version} */\n\n${importStatements.join('\n')}\n\n${
    result.value
  }${bib}`;
  writeFileToFolder(templateOptions.output, typst);
  // renderTex(mystTemplate, {
  //   contentOrPath: result.value,
  //   outputPath: templateOptions.output,
  //   frontmatter,
  //   parts,
  //   options: templateOptions,
  //   bibliography: [DEFAULT_BIB_FILENAME],
  //   sourceFile: file,
  //   imports: mergeTemplateImports(collectedImports, result),
  //   force,
  //   packages: templateYml.packages,
  //   filesPath,
  // });
  return { tempFolders: [] };
}

export async function runTypstExport(
  session: ISession,
  file: string,
  exportOptions: ExportWithOutput,
  projectPath?: string,
  clean?: boolean,
  extraLinkTransformers?: LinkTransformer[],
): Promise<ExportResults> {
  if (clean) cleanOutput(session, exportOptions.output);
  let result: ExportResults;
  if (exportOptions.template === null) {
    result = await localArticleToTexRaw(session, exportOptions, projectPath, extraLinkTransformers);
  } else {
    result = await localArticleToTexTemplated(
      session,
      file,
      exportOptions,
      projectPath,
      clean,
      extraLinkTransformers,
    );
  }
  return result;
}

export async function runTypstZipExport(
  session: ISession,
  file: string,
  exportOptions: ExportWithOutput,
  projectPath?: string,
  clean?: boolean,
  extraLinkTransformers?: LinkTransformer[],
): Promise<ExportResults> {
  if (clean) cleanOutput(session, exportOptions.output);
  const zipOutput = exportOptions.output;
  const texFolder = createTempFolder(session);
  exportOptions.output = path.join(
    texFolder,
    `${path.basename(zipOutput, path.extname(zipOutput))}.tex`,
  );
  await runTypstExport(session, file, exportOptions, projectPath, false, extraLinkTransformers);
  session.log.info(`🤐 Zipping tex outputs to ${zipOutput}`);
  const zip = new AdmZip();
  zip.addLocalFolder(texFolder);
  zip.writeZip(zipOutput);
  return { tempFolders: [texFolder] };
}

export async function localArticleToTypst(
  session: ISession,
  file: string,
  opts: ExportOptions,
  templateOptions?: Record<string, any>,
  extraLinkTransformers?: LinkTransformer[],
): Promise<ExportResults> {
  let { projectPath } = opts;
  if (!projectPath) projectPath = await findCurrentProjectAndLoad(session, path.dirname(file));
  if (projectPath) await loadProjectFromDisk(session, projectPath);
  const exportOptionsList = (
    await collectTexExportOptions(session, file, 'typ', [ExportFormats.typst], projectPath, opts)
  ).map((exportOptions) => {
    return { ...exportOptions, ...templateOptions };
  });
  const results: ExportResults = { tempFolders: [] };
  await resolveAndLogErrors(
    session,
    exportOptionsList.map(async (exportOptions) => {
      let exportResults: ExportResults;
      if (path.extname(exportOptions.output) === '.zip') {
        exportResults = await runTypstZipExport(
          session,
          file,
          exportOptions,
          projectPath,
          opts.clean,
          extraLinkTransformers,
        );
      } else {
        exportResults = await runTypstExport(
          session,
          file,
          exportOptions,
          projectPath,
          opts.clean,
          extraLinkTransformers,
        );
      }
      results.tempFolders.push(...exportResults.tempFolders);
    }),
    opts.throwOnFailure,
  );
  return results;
}
