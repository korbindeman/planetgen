/** Load the fields a variant saved. Finish must never silently regenerate them. */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const Projects=require('../src/projects');
const Pipeline=require('../src/pipeline');
const Layout=require('../src/layout-artifact');
const Shape=require('../src/shape-artifact');

export async function loadSavedPlanet(root, project, variantId) {
 const raw=JSON.parse(await readFile(join(root,Projects.catalogPath(project)),'utf8'));
 const catalog=Projects.parseCatalog(raw,project);
 const variant=catalog.variants.find(v=>v.id===variantId&&!v.deleted);
 if(!variant) throw new Error(`No live variant ${variantId} in ${project}`);
 const layoutText=await readFile(join(root,Projects.layoutPath(project,variantId)),'utf8');
 const shapeText=await readFile(join(root,Projects.shapePath(project,variantId)),'utf8');
 const layout=JSON.parse(layoutText), shape=JSON.parse(shapeText);
 const layoutFields=Layout.toFields(layout), shapeFields=Shape.toFields(shape);
 if(!layoutFields||!shapeFields) throw new Error(`Unreadable saved Layout/Shape on ${variantId}; regenerate explicitly before baking`);
 if(layout.seed!=null&&layout.seed!==variant.seed) throw new Error('Saved Layout seed differs from variant');
 const shapeSeed=Projects.Variants.effectiveShapeSeed(variant);
 if(shape.shapeSeed!=null&&shape.shapeSeed!==shapeSeed) throw new Error('Saved Shape seed differs from variant');
 if(shape.jitter!=null&&layout.jitter!=null&&shape.jitter!==layout.jitter) throw new Error('Saved meshes have different jitter');
 const config=Pipeline.freezeConfig({project,seed:variant.seed,shapeSeed,
  values:Projects.recipeOf(variant),n:layout.n,jitter:layout.jitter,quiet:true,detailPass:true});
 const planet=Pipeline.createPlanet(config), cache={};
 if(!Pipeline.stages.applyLayoutFields(planet,layoutFields,cache)
  ||!Pipeline.stages.applyShapeFields(planet,shapeFields,cache)) throw new Error(`Saved mesh does not match fields on ${variantId}`);
 const fingerprint=createHash('sha256').update(layoutText).update(shapeText)
  .update(JSON.stringify({body:variant.body,seed:variant.seed,shapeSeed})).digest('hex');
 return {planet:require('../src/pipeline/document').toLegacy(planet),variant,fingerprint};
}
