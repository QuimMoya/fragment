import { BufferGeometry, Material, Matrix4 } from 'three';
import { Items, IFragment, ExportedFragment } from './base-types';
import { FragmentMesh } from './fragment-mesh';
import { Blocks } from './blocks';
import { BVH } from './bvh';

/*
 * Fragments can contain one or multiple Instances of one or multiple Blocks
 * Each Instance is identified by an instanceID (property of THREE.InstancedMesh)
 * Each Block identified by a blockID (custom bufferAttribute per vertex)
 * Both instanceId and blockId are unsigned integers starting at 0 and going up sequentially
 * A specific Block of a specific Instance is an Item, identified by an itemID
 *
 * For example:
 * Imagine a fragment mesh with 8 instances and 2 elements (16 items, identified from A to P)
 * It will have instanceIds from 0 to 8, and blockIds from 0 to 2
 * If we raycast it, we will get an instanceId and the index of the found triangle
 * We can use the index to get the blockId for that triangle
 * Combining instanceId and blockId using the elementMap will give us the itemId
 * The items will look like this:
 *
 *    [ A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P ]
 *
 *  Where the criteria to sort the items is the following (Y-axis is instance, X-axis is block):
 *
 *        A  C  E  G  I  K  M  O
 *        B  D  F  H  J  L  N  P
 * */

export class Fragment implements IFragment {
  mesh: FragmentMesh;
  capacity: number;
  fragments: { [id: string]: Fragment } = {};
  id: string;
  blocks: Blocks;

  items: number[] = [];
  hiddenItems: { [id: number]: Items } = {};

  constructor(geometry: BufferGeometry, material: Material | Material[], count: number) {
    this.mesh = new FragmentMesh(geometry, material, count);
    this.id = this.mesh.uuid;
    this.capacity = count;
    this.blocks = new Blocks(this);
    BVH.apply(geometry);
  }

  dispose(disposeResources = true) {
    (this.items as any) = null;

    if (disposeResources) {
      this.mesh.material.forEach((mat) => mat.dispose());
      BVH.dispose(this.mesh.geometry);
      this.mesh.geometry.dispose();
    }

    this.mesh.dispose();
    (this.mesh as any) = null;

    this.disposeNestedFragments();
  }

  getItemID(instanceID: number, blockID: number) {
    const index = this.getItemIndex(instanceID, blockID);
    return this.items[index];
  }

  getInstanceAndBlockID(itemID: number) {
    const index = this.items.indexOf(itemID);
    const instanceID = this.getInstanceIDFromIndex(index);
    const blockID = index % this.blocks.count;
    return { instanceID, blockID };
  }

  getVertexBlockID(geometry: BufferGeometry, index: number) {
    return geometry.attributes.blockID.array[index];
  }

  getItemData(itemID: number) {
    const index = this.items.indexOf(itemID);
    const instanceID = Math.ceil(index / this.blocks.count);
    const blockID = index % this.blocks.count;
    return { instanceID, blockID };
  }

  getInstance(instanceID: number, matrix: Matrix4) {
    return this.mesh.getMatrixAt(instanceID, matrix);
  }

  setInstance(instanceID: number, items: Items) {
    this.checkIfInstanceExist(instanceID);
    this.mesh.setMatrixAt(instanceID, items.transform);
    this.mesh.instanceMatrix.needsUpdate = true;

    if (items.ids) {
      this.saveItemsInMap(items.ids, instanceID);
    }
  }

  addInstances(items: Items[]) {
    this.resizeCapacityIfNeeded(items.length);
    const start = this.mesh.count;
    this.mesh.count += items.length;
    for (let i = 0; i < items.length; i++) {
      this.setInstance(start + i, items[i]);
    }
  }

  removeInstances(itemsIDs: number[]) {
    if (this.mesh.count <= 1) {
      this.clear();
      return;
    }

    this.deleteAndRearrangeInstances(itemsIDs);
    this.mesh.count -= itemsIDs.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.mesh.clear();
    this.mesh.count = 0;
    this.items = [];
  }

  addFragment(id: string, material = this.mesh.material) {
    const newGeometry = this.initializeGeometry();
    if (material === this.mesh.material) {
      this.copyGroups(newGeometry);
    }

    this.fragments[id] = new Fragment(newGeometry, material, this.capacity);
    return this.fragments[id];
  }

  removeFragment(id: string) {
    const fragment = this.fragments[id];
    if (fragment) {
      fragment.dispose(false);
      delete this.fragments[id];
    }
  }

  resetVisibility() {
    this.blocks.reset();
    const hiddenInstances = Object.keys(this.hiddenItems).map((id) => parseInt(id, 10));
    this.makeInstancesInvisible(hiddenInstances);
    this.hiddenItems = {};
  }

  setVisibility(itemIDs: number[], visible: boolean) {
    if (this.blocks.count > 1) {
      this.toggleBlockVisibility(visible, itemIDs);
    } else {
      this.toggleInstanceVisibility(visible, itemIDs);
    }
  }

  resize(size: number) {
    const newMesh = this.createFragmentMeshWithNewSize(size);
    this.capacity = size;
    const oldMesh = this.mesh;
    oldMesh.parent?.add(newMesh);
    oldMesh.removeFromParent();
    this.mesh = newMesh;
    oldMesh.dispose();
  }

  async export() {
    const geometryBuffer = await this.mesh.export();
    const geometry = new File([new Blob([geometryBuffer])], `${this.id}.glb`);

    const fragmentData: ExportedFragment = {
      matrices: Array.from(this.mesh.instanceMatrix.array),
      ids: this.items
    };

    const dataString = JSON.stringify(fragmentData);
    const data = new File([new Blob([dataString])], `${this.id}.json`);

    return { geometry, data };
  }

  private copyGroups(newGeometry: BufferGeometry) {
    newGeometry.groups = [];
    for (const group of this.mesh.geometry.groups) {
      newGeometry.groups.push({ ...group });
    }
  }

  private initializeGeometry() {
    const newGeometry = new BufferGeometry();
    newGeometry.setAttribute('position', this.mesh.geometry.attributes.position);
    newGeometry.setAttribute('normal', this.mesh.geometry.attributes.normal);
    newGeometry.setAttribute('blockID', this.mesh.geometry.attributes.blockID);
    newGeometry.setIndex(Array.from(this.mesh.geometry.index.array));
    return newGeometry;
  }

  private saveItemsInMap(ids: number[], instanceId: number) {
    this.checkBlockNumberValid(ids);
    let counter = 0;
    for (const id of ids) {
      const index = this.getItemIndex(instanceId, counter);
      this.items[index] = id;
      counter++;
    }
  }

  private resizeCapacityIfNeeded(newSize: number) {
    const necessaryCapacity = newSize + this.mesh.count;
    if (necessaryCapacity > this.capacity) {
      this.resize(necessaryCapacity);
    }
  }

  private createFragmentMeshWithNewSize(capacity: number) {
    const newMesh = new FragmentMesh(this.mesh.geometry, this.mesh.material, capacity);
    newMesh.count = this.mesh.count;
    return newMesh;
  }

  private disposeNestedFragments() {
    const fragments = Object.values(this.fragments);
    for (let i = 0; i < fragments.length; i++) {
      fragments[i].dispose();
    }
    this.fragments = {};
  }

  private checkBlockNumberValid(ids: number[]) {
    if (ids.length > this.blocks.count) {
      throw new Error(
        `You passed more items (${ids.length}) than blocks in this instance (${this.blocks.count})`
      );
    }
  }

  private checkIfInstanceExist(index: number) {
    if (index > this.mesh.count) {
      throw new Error(
        `The given index (${index}) exceeds the instances in this fragment (${this.mesh.count})`
      );
    }
  }

  // Assigns the index of the removed instance to the last instance
  // F.e. let there be 6 instances: (A) (B) (C) (D) (E) (F)
  // If instance (C) is removed: -> (A) (B) (F) (D) (E)
  private deleteAndRearrangeInstances(ids: number[]) {
    const deletedItems: Items[] = [];

    for (const id of ids) {
      const deleted = this.deleteAndRearrange(id);
      if (deleted) {
        deletedItems.push(deleted);
      }
    }

    for (const id of ids) {
      delete this.hiddenItems[id];
    }

    return deletedItems;
  }

  private deleteAndRearrange(id: number) {
    const index = this.items.indexOf(id);
    if (index === -1) return null;

    this.mesh.count--;
    const lastElement = this.mesh.count;

    this.items[index] = this.items[lastElement];
    this.items.pop();

    const instanceId = this.getInstanceIDFromIndex(id);
    const tempMatrix = new Matrix4();

    const transform = new Matrix4();
    this.mesh.setMatrixAt(instanceId, transform);

    this.mesh.getMatrixAt(lastElement, tempMatrix);
    this.mesh.setMatrixAt(instanceId, tempMatrix);

    return { ids: [id], transform } as Items;
  }

  private getItemIndex(instanceId: number, blockId: number) {
    return instanceId * this.blocks.count + blockId;
  }

  private getInstanceIDFromIndex(itemIndex: number) {
    return Math.trunc(itemIndex / this.blocks.count);
  }

  private toggleInstanceVisibility(visible: boolean, itemIDs: number[]) {
    if (visible) {
      this.makeInstancesVisible(itemIDs);
    } else {
      this.makeInstancesInvisible(itemIDs);
    }
  }

  private makeInstancesInvisible(itemIDs: number[]) {
    const deletedItems = this.deleteAndRearrangeInstances(itemIDs);
    for (const item of deletedItems) {
      if (item.ids) {
        this.hiddenItems[item.ids[0]] = item;
      }
    }
  }

  private makeInstancesVisible(itemIDs: number[]) {
    const items: Items[] = [];
    for (const id of itemIDs) {
      items.push(this.hiddenItems[id]);
      delete this.hiddenItems[id];
    }
    this.addInstances(items);
  }

  private toggleBlockVisibility(visible: boolean, itemIDs: number[]) {
    if (visible) {
      this.blocks.add(itemIDs, false);
    } else {
      this.blocks.remove(itemIDs);
    }
  }
}
