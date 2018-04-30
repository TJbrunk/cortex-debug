import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as xml2js from 'xml2js';

import { hexFormat, binaryFormat, createMask, extractBits } from './utils';
import { ProviderResult } from 'vscode';
import { NumberFormat, NodeSetting } from '../common';
import reporting from '../reporting';

export enum RecordType {
    Peripheral = 1,
    Register,
    Field,
    Cluster
}

export enum AccessType {
    ReadOnly = 1,
    ReadWrite,
    WriteOnly
}

const ACCESS_TYPE_MAP = {
    'read-only': AccessType.ReadOnly,
    'write-only': AccessType.WriteOnly,
    'read-write': AccessType.ReadWrite,
    'writeOnce': AccessType.WriteOnly,
    'read-writeOnce': AccessType.ReadWrite
};

export class TreeNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public contextValue: string,
        public node: BaseNode
    ) {
        super(label, collapsibleState);
        this.command = {
            command: 'cortex-debug.peripherals.selectedNode',
            arguments: [node],
            title: 'Selected Node'
        };
    }
}

export class BaseNode {
    public expanded: boolean;
    public format: NumberFormat;

    constructor(public recordType: RecordType) {
        this.expanded = false;
        this.format = NumberFormat.Auto;
    }

    public selected(): Thenable<boolean> { return Promise.resolve(false); }

    public performUpdate(): Thenable<any> {
        return Promise.resolve(false);
    }
    
    public getChildren(): BaseNode[] { return []; }
    public getTreeNode(): TreeNode { return null; }
    public getCopyValue(): string { return null; }
    public setFormat(format: NumberFormat): void {
        this.format = format;
    }
}

function parseInteger(value: string): number {
    if ((/^0b([01]+)$/i).test(value)) {
        return parseInt(value.substring(2), 2);
    }
    else if ((/^0x([0-9a-f]+)$/i).test(value)) {
        return parseInt(value.substring(2), 16);
    }
    else if ((/^[0-9]+/i).test(value)) {
        return parseInt(value, 10);
    }
    else if ((/^#[0-1]+/i).test(value)) {
        return parseInt(value.substring(1), 2);
    }
    return undefined;
}

function parseDimIndex(spec: string, count: number): string[] {
    if (spec.indexOf(',') !== -1) {
        const components = spec.split(',').map((c) => c.trim());
        if (components.length !== count) {
            throw new Error('dimIndex Element has invalid specification.');
        }
        return components;
    }

    if (/^([0-9]+)\-([0-9]+)$/i.test(spec)) {
        const parts = spec.split('-').map((p) => parseInteger(p));
        const start = parts[0];
        const end = parts[1];

        const numElements = end - start + 1;
        if (numElements < count) {
            throw new Error('dimIndex Element has invalid specification.');
        }

        const components = [];
        for (let i = 0; i < count; i++) {
            components.push(`${start + i}`);
        }

        return components;
    }

    if (/^[a-zA-Z]\-[a-zA-Z]$/.test(spec)) {
        const start = spec.charCodeAt(0);
        const end = spec.charCodeAt(2);

        const numElements = end - start + 1;
        if (numElements < count) {
            throw new Error('dimIndex Element has invalid specification.');
        }

        const components = [];
        for (let i = 0; i < count; i++) {
            components.push(String.fromCharCode(start + i));
        }

        return components;
    }

    return [];
}

interface EnumerationMap {
    [value: number]: EnumeratedValue;
}

class EnumeratedValue {
    constructor(public name: string, public description: string, public value: number) {}
}

interface PeripheralOptions {
    name: string;
    baseAddress: number;
    totalLength: number;
    description: string;
    groupName?: string;
    accessType?: AccessType;
    size?: number;
    resetValue?: number;
}

export class PeripheralNode extends BaseNode {
    private children: Array<RegisterNode | ClusterNode>;
    public readonly name: string;
    public readonly baseAddress: number;
    public readonly description: string;
    public readonly groupName: string;
    public readonly totalLength: number;
    public readonly accessType: AccessType;
    public readonly size: number;
    public readonly resetValue: number;
    
    private currentValue: number[];

    constructor(options: PeripheralOptions) {
        super(RecordType.Peripheral);
        this.name = options.name;
        this.baseAddress = options.baseAddress;
        this.totalLength = options.totalLength;
        this.description = options.description;
        this.groupName = options.groupName || '';
        this.resetValue = options.resetValue || 0;
        this.size = options.size || 32;
        this.children = [];
    }

    public getTreeNode(): TreeNode {
        const label = this.name + '  [' + hexFormat(this.baseAddress) + ']';
        return new TreeNode(label, this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed, 'peripheral', this);
    }

    public getChildren(): Array<RegisterNode | ClusterNode> {
        return this.children;
    }

    public setChildren(children: Array<RegisterNode | ClusterNode>) {
        this.children = children;
        this.children.sort((c1, c2) => c1.offset > c2.offset ? 1 : -1);
    }

    public addChild(child: RegisterNode | ClusterNode) {
        this.children.push(child);
        this.children.sort((c1, c2) => c1.offset > c2.offset ? 1 : -1);
    }

    public getBytes(offset: number, size: number): Uint8Array {
        try {
            return new Uint8Array(this.currentValue.slice(offset, offset + size));
        }
        catch (e) {
            return new Uint8Array(0);
        }
    }

    public getAddress(offset: number) {
        return this.baseAddress + offset;
    }

    public getFormat(): NumberFormat {
        return this.format;
    }

    public update(): Thenable<boolean> {
        return new Promise((resolve, reject) => {
            if (!this.expanded) { resolve(false); return; }

            vscode.debug.activeDebugSession.customRequest('read-memory', { address: this.baseAddress, length: this.totalLength }).then((data) => {
                this.currentValue = data.bytes;

                this.children.forEach((r) => r.update());

                resolve(true);
            }, (error) => {
                reject(error);
            });
        });
    }

    public selected(): Thenable<boolean> {
        return this.update();
    }

    public _saveState(): NodeSetting[] {
        const results: NodeSetting[] = [];

        if (this.format !== NumberFormat.Auto || this.expanded) {
            results.push({ node: `${this.name}`, expanded: this.expanded, format: this.format });
        }

        this.children.forEach((c) => {
            results.push(...c._saveState(`${this.name}`));
        });

        return results;
    }

    public _findByPath(path: string[]): BaseNode {
        if (path.length === 0) { return this; }
        else {
            const child = this.children.find((c) => c.name === path[0]);
            if (child) { return child._findByPath(path.slice(1)); }
            else { return null; }
        }
    }
}

interface ClusterOptions {
    name: string;
    addressOffset: number;
    accessType?: AccessType;
    size?: number;
    resetValue?: number;
}

export class ClusterNode extends BaseNode {
    private children: RegisterNode[];
    public readonly name: string;
    public readonly offset: number;
    public readonly size: number;
    public readonly resetValue: number;
    public readonly accessType: AccessType;

    constructor(private parent: PeripheralNode, options: ClusterOptions) {
        super(RecordType.Cluster);
        this.name = options.name;
        this.offset = options.addressOffset;
        this.accessType = options.accessType || AccessType.ReadWrite;
        this.size = options.size || parent.size;
        this.resetValue = options.resetValue || parent.resetValue;
        this.children = [];
        this.parent.addChild(this);
    }

    public getTreeNode(): TreeNode {
        const label = `${this.name} [${hexFormat(this.offset, 0)}]`;
        return new TreeNode(label, this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed, 'cluster', this);
    }

    public getChildren(): RegisterNode[] {
        return this.children;
    }

    public setChildren(children: RegisterNode[]) {
        this.children = children.slice(0, children.length);
        this.children.sort((r1, r2) => r1.offset > r2.offset ? 1 : -1);
    }

    public addChild(child: RegisterNode) {
        this.children.push(child);
        this.children.sort((r1, r2) => r1.offset > r2.offset ? 1 : -1);
    }

    public getBytes(offset: number, size: number): Uint8Array {
        return this.parent.getBytes(this.offset + offset, size);
    }

    public getAddress(offset: number) {
        return this.parent.getAddress(this.offset + offset);
    }

    public getFormat(): NumberFormat {
        if (this.format !== NumberFormat.Auto) { return this.format; }
        else { return this.parent.getFormat(); }
    }

    public update(): Thenable<boolean> {
        return Promise.resolve(true);
    }

    public _saveState(path: string): NodeSetting[] {
        const results: NodeSetting[] = [];

        if (this.format !== NumberFormat.Auto || this.expanded) {
            results.push({ node: `${path}.${this.name}`, expanded: this.expanded, format: this.format });
        }

        this.children.forEach((c) => {
            results.push(...c._saveState(`${path}.${this.name}`));
        });

        return results;
    }

    public _findByPath(path: string[]): BaseNode {
        if (path.length === 0) { return this; }
        else {
            const child = this.children.find((c) => c.name === path[0]);
            if (child) { return child._findByPath(path.slice(1)); }
            else { return null; }
        }
    }
}

interface RegisterOptions {
    name: string;
    addressOffset: number;
    accessType?: AccessType;
    size?: number;
    resetValue?: number;
}

export class RegisterNode extends BaseNode {
    public children: FieldNode[];
    public readonly name: string;
    public readonly offset: number;
    public readonly accessType: AccessType;
    public readonly size: number;
    public readonly resetValue: number;
    
    private maxValue: number;
    private hexLength: number;
    private hexRegex: RegExp;
    private binaryRegex: RegExp;
    private currentValue: number;
    
    constructor(public parent: PeripheralNode | ClusterNode, options: RegisterOptions) {
        super(RecordType.Register);
        
        this.name = options.name;
        this.offset = options.addressOffset;
        this.accessType = options.accessType || parent.accessType;
        this.size = options.size || parent.size;
        this.resetValue = options.resetValue !== undefined ? options.resetValue : parent.resetValue;
        this.currentValue = this.resetValue;

        this.hexLength = Math.ceil(this.size / 4);
        
        this.maxValue = Math.pow(2, this.size);
        this.binaryRegex = new RegExp(`^0b[01]{1,${this.size}}$`, 'i');
        this.hexRegex = new RegExp(`^0x[0-9a-f]{1,${this.hexLength}}$`, 'i');
        this.children = [];
        if (this.parent instanceof PeripheralNode) {
            (this.parent as PeripheralNode).addChild(this);
        }
        else {
            (this.parent as ClusterNode).addChild(this);
        }
    }

    public reset() {
        this.currentValue = this.resetValue;
    }

    public extractBits(offset: number, width: number): number {
        return extractBits(this.currentValue, offset, width);
    }

    public updateBits(offset: number, width: number, value: number): Thenable<boolean> {
        return new Promise((resolve, reject) => {
            const limit = Math.pow(2, width);
            if (value > limit) {
                return reject(`Value entered is invalid. Maximum value for this field is ${limit - 1} (${hexFormat(limit - 1, 0)})`);
            }
            else {
                const mask = createMask(offset, width);
                const sv = value << offset;
                const newval = (this.currentValue & ~mask) | sv;
                this.updateValueInternal(newval).then(resolve, reject);
            }
        });
    }

    public getTreeNode(): TreeNode {
        let cv = 'registerRW';
        if (this.accessType === AccessType.ReadOnly) { cv = 'registerRO'; }
        else if (this.accessType === AccessType.WriteOnly) { cv = 'registerWO'; }

        let label: string = `${this.name} [${hexFormat(this.offset, 0)}]`;
        if (this.accessType === AccessType.WriteOnly) {
            label += ' - <Write Only>';
        }
        else {
            switch (this.getFormat()) {
                case NumberFormat.Decimal:
                    label += ` = ${this.currentValue.toString()}`;
                    break;
                case NumberFormat.Binary:
                    label += ` = ${binaryFormat(this.currentValue, this.hexLength * 4, false, true)}`;
                    break;
                default:
                    label += ` = ${hexFormat(this.currentValue, this.hexLength)}`;
                    break;
            }
            
        }

        const collapseState = this.children && this.children.length > 0
            ? (this.expanded ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None;
        
        return new TreeNode(label, collapseState, cv, this);
    }

    public getChildren(): FieldNode[] {
        return this.children || [];
    }

    public setChildren(children: FieldNode[]) {
        this.children = children.slice(0, children.length);
        this.children.sort((f1, f2) => f1.offset > f2.offset ? 1 : -1);
    }

    public addChild(child: FieldNode) {
        this.children.push(child);
        this.children.sort((f1, f2) => f1.offset > f2.offset ? 1 : -1);
    }

    public getFormat(): NumberFormat {
        if (this.format !== NumberFormat.Auto) { return this.format; }
        else { return this.parent.getFormat(); }
    }

    public getCopyValue(): string {
        switch (this.getFormat()) {
            case NumberFormat.Decimal:
                return this.currentValue.toString();
            case NumberFormat.Binary:
                return binaryFormat(this.currentValue, this.hexLength * 4);
            default:
                return hexFormat(this.currentValue, this.hexLength);
        }
    }

    public performUpdate(): Thenable<boolean> {
        return new Promise((resolve, reject) => {
            vscode.window.showInputBox({ prompt: 'Enter new value: (prefix hex with 0x, binary with 0b)' }).then((val) => {
                let numval;
                if (val.match(this.hexRegex)) { numval = parseInt(val.substr(2), 16); }
                else if (val.match(this.binaryRegex)) { numval = parseInt(val.substr(2), 2); }
                else if (val.match(/^[0-9]+/)) {
                    numval = parseInt(val, 10);
                    if (numval >= this.maxValue) {
                        return reject(`Value entered (${numval}) is greater than the maximum value of ${this.maxValue}`);
                    }
                }
                else {
                    return reject('Value entered is not a valid format.');
                    
                }

                this.updateValueInternal(numval).then(resolve, reject);
            });
        });
    }

    private updateValueInternal(value: number): Thenable<boolean> {
        const address = this.parent.getAddress(this.offset);
        const bytes = [];
        const numbytes = this.size / 8;

        for (let i = 0; i < numbytes; i++) {
            const byte = value & 0xFF;
            value = value >>> 8;
            let bs = byte.toString(16);
            if (bs.length === 1) { bs = '0' + bs; }
            bytes[i] = bs;
        }

        return new Promise((resolve, reject) => {
            vscode.debug.activeDebugSession.customRequest('write-memory', { address: address, data: bytes.join('') }).then((result) => {
                this.parent.update().then(() => {}, () => {});
                resolve(true);
            }, reject);
        });
    }

    public update(): Thenable<boolean> {
        const bc = this.size / 8;
        const bytes = this.parent.getBytes(this.offset, bc);
        const buffer = new Buffer(bytes);
        switch (bc) {
            case 1:
                this.currentValue = buffer.readUInt8(0);
                break;
            case 2:
                this.currentValue = buffer.readUInt16LE(0);
                break;
            case 4:
                this.currentValue = buffer.readUInt32LE(0);
                break;
            default:
                vscode.window.showErrorMessage(`Register ${this.name} has invalid size: ${this.size}. Should be 8, 16 or 32.`);
                break;
        }
        this.children.forEach((f) => f.update());

        return Promise.resolve(true);
    }

    public _saveState(path: string): NodeSetting[] {
        const results: NodeSetting[] = [];

        if (this.format !== NumberFormat.Auto || this.expanded) {
            results.push({ node: `${path}.${this.name}`, expanded: this.expanded, format: this.format });
        }

        this.children.forEach((c) => {
            results.push(...c._saveState(`${path}.${this.name}`));
        });

        return results;
    }

    public _findByPath(path: string[]): BaseNode {
        if (path.length === 0) { return this; }
        else if (path.length === 1) {
            const child = this.children.find((c) => c.name === path[0]);
            return child;
        }
        else { return null; }
    }
}

interface FieldOptions {
    name: string;
    description: string;
    offset: number;
    width: number;
    enumeration?: EnumerationMap;
    accessType?: AccessType;
}

export class FieldNode extends BaseNode {
    public readonly name: string;
    public readonly description: string;
    public readonly offset: number;
    public readonly width: number;
    public readonly accessType: AccessType;
    
    private enumeration: EnumerationMap;
    private enumerationValues: string[];
    private enumerationMap: any;

    constructor(private parent: RegisterNode, options: FieldOptions) {
        super(RecordType.Field);

        this.name = options.name;
        this.description = options.description;
        this.offset = options.offset;
        this.width = options.width;
        
        if (!options.accessType) { this.accessType = parent.accessType; }
        else {
            if (parent.accessType === AccessType.ReadOnly && options.accessType !== AccessType.ReadOnly) {
                this.accessType = AccessType.ReadOnly;
            }
            else if (parent.accessType === AccessType.WriteOnly && options.accessType !== AccessType.WriteOnly) {
                this.accessType = AccessType.WriteOnly;
            }
            else {
                this.accessType = options.accessType;
            }
        }

        if (options.enumeration) {
            this.enumeration = options.enumeration;
            this.enumerationMap = {};
            this.enumerationValues = [];

            // tslint:disable-next-line:forin
            for (const key in options.enumeration) {
                const val = key;
                const name = options.enumeration[key].name;

                this.enumerationValues.push(name);
                this.enumerationMap[name] = key;
            }
        }

        this.parent.addChild(this);
    }

    public getTreeNode(): TreeNode {
        const value = this.parent.extractBits(this.offset, this.width);
        let evalue = null;
        let label = this.name;

        const rangestart = this.offset;
        const rangeend = this.offset + this.width - 1;
        let context = 'field';

        label += `[${rangeend}:${rangestart}]`;
        if (this.name.toLowerCase() === 'reserved')  {
            context = 'field-res';
        }
        else {
            if (this.accessType === AccessType.WriteOnly) {
                label += ' - <Write Only>';
            }
            else {
                let formattedValue: string = '';

                switch (this.getFormat()) {
                    case NumberFormat.Decimal:
                        formattedValue = value.toString();
                        break;
                    case NumberFormat.Binary:
                        formattedValue = binaryFormat(value, this.width);
                        break;
                    case NumberFormat.Hexidecimal:
                        formattedValue = hexFormat(value, Math.ceil(this.width / 4), true);
                        break;
                    default:
                        formattedValue = this.width >= 4 ? hexFormat(value, Math.ceil(this.width / 4), true) : binaryFormat(value, this.width);
                        break;
                }
                
                if (this.enumeration && this.enumeration[value]) {
                    evalue = this.enumeration[value];
                    label += ` = ${evalue.name} (${formattedValue})`;
                }
                else {
                    label += ` = ${formattedValue}`;
                }
            }
        }

        if (this.parent.accessType === AccessType.ReadOnly) {
            context = 'field-ro';
        }

        return new TreeNode(label, vscode.TreeItemCollapsibleState.None, context, this);
    }

    public performUpdate(): Thenable<any> {
        return new Promise((resolve, reject) => {
            if (this.enumeration) {
                vscode.window.showQuickPick(this.enumerationValues).then((val) => {
                    if (val === undefined) { return reject('Input not selected'); }
                    
                    const numval = this.enumerationMap[val];
                    this.parent.updateBits(this.offset, this.width, numval).then(resolve, reject);
                });
            }
            else {
                vscode.window.showInputBox({ prompt: 'Enter new value: (prefix hex with 0x, binary with 0b)' }).then((val) => {
                    const numval = parseInteger(val);
                    if (numval === undefined) {
                        return reject('Unable to parse input value.');
                    }
                    this.parent.updateBits(this.offset, this.width, numval).then(resolve, reject);
                });
            }
        });
    }

    public getCopyValue(): string {
        const value = this.parent.extractBits(this.offset, this.width);
        switch (this.getFormat()) {
            case NumberFormat.Decimal:
                return value.toString();
            case NumberFormat.Binary:
                return binaryFormat(value, this.width);
            case NumberFormat.Hexidecimal:
                return hexFormat(value, Math.ceil(this.width / 4), true);
            default:
                return this.width >= 4 ? hexFormat(value, Math.ceil(this.width / 4), true) : binaryFormat(value, this.width);
        }
    }

    public getFormat(): NumberFormat {
        if (this.format !== NumberFormat.Auto) { return this.format; }
        else { return this.parent.getFormat(); }
    }

    public update() {}

    public _saveState(path: string): NodeSetting[] {
        if (this.format !== NumberFormat.Auto) {
            return [ {node: `${path}.${this.name}`, format: this.format }];
        }
        else {
            return [];
        }
    }

    public _findByPath(path: string[]): BaseNode {
        if (path.length === 0) { return this; }
        else { return null; }
    }
}

export class PeripheralTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    // tslint:disable-next-line:variable-name
    public _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined> = new vscode.EventEmitter<TreeNode | undefined>();
    public readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this._onDidChangeTreeData.event;
    
    private peripherials: PeripheralNode[] = [];
    private loaded: boolean = false;
    private SVDPath: string = '';

    private defaultResetValue: number = 0x00000000;
    private defaultSize: number = 32;

    constructor() {

    }

    private _saveState(path: string): void {
        const state: NodeSetting[] = [];
        this.peripherials.forEach((p) => {
            state.push(... p._saveState());
        });
        
        fs.writeFileSync(path, JSON.stringify(state), { encoding: 'utf8', flag: 'w' });
    }

    private _parseFields(fieldInfo: any[], parent: RegisterNode): FieldNode[] {
        const fields: FieldNode[] = [];

        fieldInfo.map((f) => {
            let offset;
            let width;
            const description = f.description ? f.description[0] : '';

            if (f.bitOffset && f.bitWidth) {
                offset = parseInteger(f.bitOffset[0]);
                width = parseInteger(f.bitWidth[0]);
            }
            else if (f.bitRange) {
                let range = f.bitRange[0];
                range = range.substring(1, range.length - 1);
                range = range.split(':');
                const end = parseInteger(range[0]);
                const start = parseInteger(range[1]);

                width = end - start + 1;
                offset = start;
            }
            else if (f.msb && f.lsb) {
                const msb = parseInteger(f.msb[0]);
                const lsb = parseInteger(f.lsb[0]);

                width = msb - lsb + 1;
                offset = lsb;
            }
            else {
                // tslint:disable-next-line:max-line-length
                throw new Error(`Unable to parse SVD file: field ${f.name[0]} must have either bitOffset and bitWidth elements, bitRange Element, or msb and lsb elements.`);
            }

            let valueMap: EnumerationMap = null;
            if (f.enumeratedValues) {
                valueMap = {};

                const ev = f.enumeratedValues[0];
                ev.enumeratedValue.map((ev) => {
                    if (ev.value && ev.value.length > 0) {
                        const evname = ev.name[0];
                        const evdesc = ev.description[0];
                        const val = ev.value[0].toLowerCase();
                        const evvalue = parseInteger(val);
                        
                        valueMap[evvalue] = new EnumeratedValue(evname, evdesc, evvalue);
                    }
                });
            }

            const baseOptions = {
                name: f.name[0],
                description: description,
                offset: offset,
                width: width,
                enumeration: valueMap
            };

            if (f.dim) {
                if (!f.dimIncrement) { throw new Error(`Unable to parse SVD file: field ${f.name[0]} has dim element, with no dimIncrement element.`); }

                const count = parseInteger(f.dim[0]);
                const increment = parseInteger(f.dimIncrement[0]);
                let index = [];
                if (f.dimIndex) {
                    index = parseDimIndex(f.dimIndex[0], count);
                }
                else {
                    for (let i = 0; i < count; i++) { index.push(`${i}`); }
                }

                const namebase: string = f.name[0];
                const offsetbase = offset;
                
                for (let i = 0; i < count; i++) {
                    const name = namebase.replace('%s', index[i]);
                    fields.push(new FieldNode(parent, { ...baseOptions, name: name, offset: offsetbase + (increment * i) }));
                }
            }
            else {
                fields.push(new FieldNode(parent, { ...baseOptions }));
            }
        });

        return fields;
    }

    private _parseRegisters(regInfo: any[], parent: PeripheralNode | ClusterNode): RegisterNode[] {
        const registers: RegisterNode[] = [];

        regInfo.forEach((r) => {
            const baseOptions: any = {};
            if (r.access) {
                baseOptions.accessType = ACCESS_TYPE_MAP[r.access[0]];
            }
            if (r.size) {
                baseOptions.size = parseInteger(r.size[0]);
            }
            if (r.resetValue) {
                baseOptions.resetValue = parseInteger(r.resetValue[0]);
            }

            if (r.dim) {
                if (!r.dimIncrement) { throw new Error(`Unable to parse SVD file: register ${r.name[0]} has dim element, with no dimIncrement element.`); }

                const count = parseInteger(r.dim[0]);
                const increment = parseInteger(r.dimIncrement[0]);
                let index = [];
                if (r.dimIndex) {
                    index = parseDimIndex(r.dimIndex[0], count);
                }
                else {
                    for (let i = 0; i < count; i++) { index.push(`${i}`); }
                }

                const namebase: string = r.name[0];
                const offsetbase = parseInteger(r.addressOffset[0]);

                for (let i = 0; i < count; i++) {
                    const name = namebase.replace('%s', index[i]);

                    const register = new RegisterNode(parent, { ...baseOptions, name: name, addressOffset: offsetbase + (increment * i) });
                    if (r.fields && r.fields.length === 1) {
                        this._parseFields(r.fields[0].field, register);
                    }
                    registers.push(register);
                }
            }
            else {
                const register = new RegisterNode(parent, { ...baseOptions, name: r.name[0], addressOffset: parseInteger(r.addressOffset[0]) });
                if (r.fields && r.fields.length === 1) {
                    this._parseFields(r.fields[0].field, register);
                }
                registers.push(register);
            }
        });

        registers.sort((a, b) => {
            if (a.offset < b.offset) { return -1; }
            else if (a.offset > b.offset) { return 1; }
            else { return 0; }
        });

        return registers;
    }

    private _parseClusters(clusterInfo: any, parent: PeripheralNode): ClusterNode[] {
        const clusters: ClusterNode[] = [];

        if (!clusterInfo) { return []; }

        clusterInfo.forEach((c) => {
            const baseOptions: any = {};
            if (c.access) {
                baseOptions.accessType = ACCESS_TYPE_MAP[c.access[0]];
            }
            if (c.size) {
                baseOptions.size = parseInteger(c.size[0]);
            }
            if (c.resetValue) {
                baseOptions.resetValue = parseInteger(c.resetValue);
            }

            if (c.dim) {
                if (!c.dimIncrement) { throw new Error(`Unable to parse SVD file: cluster ${c.name[0]} has dim element, with no dimIncrement element.`); }

                const count = parseInteger(c.dim[0]);
                const increment = parseInteger(c.dimIncrement[0]);

                let index = [];
                if (c.dimIndex) {
                    index = parseDimIndex(c.dimIndex[0], count);
                }
                else {
                    for (let i = 0; i < count; i++) { index.push(`${i}`); }
                }

                const namebase: string = c.name[0];
                const offsetbase = parseInteger(c.addressOffset[0]);

                for (let i = 0; i < count; i++) {
                    const name = namebase.replace('%s', index[i]);

                    const cluster = new ClusterNode(parent, { ...baseOptions, name: name, addressOffset: offsetbase + (increment * i) });
                    if (c.register) {
                        this._parseRegisters(c.register, cluster);
                    }
                    clusters.push(cluster);
                }

            }
            else {
                const cluster = new ClusterNode(parent, { ...baseOptions, name: c.name[0], addressOffset: parseInteger(c.addressOffset[0]) });
                if (c.register) {
                    this._parseRegisters(c.register, cluster);
                    clusters.push(cluster);
                }
            }

        });

        return clusters;
    }

    private _parsePeripheral(p: any, defaults: { accessType: AccessType, size: number, resetValue: number }): PeripheralNode {
        const ab = p.addressBlock[0];
        const totalLength = parseInteger(ab.size[0]);
        
        const options: any = {
            name: p.name[0],
            baseAddress: parseInteger(p.baseAddress[0]),
            description: p.description[0],
            totalLength: totalLength
        };

        if (p.access) { options.accessType = ACCESS_TYPE_MAP[p.access[0]]; }
        if (p.size) { options.size = parseInteger(p.size[0]); }
        if (p.resetValue) { options.resetValue = parseInteger(p.resetValue[0]); }
        if (p.groupName) { options.groupName = p.groupName[0]; }
        
        const peripheral = new PeripheralNode(options);

        const registers = this._parseRegisters(p.registers[0].register, peripheral);
        const clusters = this._parseClusters(p.registers[0].cluster, peripheral);

        return peripheral;
    }
    
    private _loadSVD(SVDFile: string): Thenable<any> {
        return new Promise((resolve, reject) => {
            fs.readFile(SVDFile, 'utf8', (err, data) => {
                xml2js.parseString(data, (err, result) => {
                    const peripheralMap = {};
                    const defaultOptions = {
                        accessType: AccessType.ReadWrite,
                        size: 32,
                        resetValue: 0x0
                    };

                    if (result.device.resetValue) {
                        defaultOptions.resetValue = parseInteger(result.device.resetValue[0]);
                    }
                    if (result.device.size) {
                        defaultOptions.size = parseInteger(result.device.size[0]);
                    }
                    if (result.device.access) {
                        defaultOptions.accessType = ACCESS_TYPE_MAP[result.device.access[0]];
                    }

                    result.device.peripherals[0].peripheral.forEach((element) => {
                        const name = element.name[0];
                        peripheralMap[name] = element;
                    });

                    // tslint:disable-next-line:forin
                    for (const key in peripheralMap) {
                        const element = peripheralMap[key];
                        if (element.$ && element.$.derivedFrom) {
                            const base = peripheralMap[element.$.derivedFrom];
                            peripheralMap[key] = {...base, ...element};
                        }
                    }

                    this.peripherials = [];
                    // tslint:disable-next-line:forin
                    for (const key in peripheralMap) {
                        this.peripherials.push(this._parsePeripheral(peripheralMap[key], defaultOptions));
                    }

                    this.peripherials.sort((p1, p2) => {
                        if (p1.groupName > p2.groupName) { return 1; }
                        else if (p1.groupName < p2.groupName) { return -1; }
                        else {
                            if (p1.name > p2.name) { return 1; }
                            else if (p1.name < p2.name) { return -1; }
                            else { return 0; }
                        }
                    });

                    this.loaded = true;

                    resolve(true);
                });
            });
        });
    }

    private _findNodeByPath(path: string): BaseNode {
        const pathParts = path.split('.');
        const peripheral = this.peripherials.find((p) => p.name === pathParts[0]);
        if (!peripheral) { return null; }
        
        return peripheral._findByPath(pathParts.slice(1));
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    public getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: TreeNode): ProviderResult<TreeNode[]> {
        if (this.loaded && this.peripherials.length > 0) {
            if (element) {
                return element.node.getChildren().map((c) => c.getTreeNode());
            }
            else {
                return this.peripherials.map((p) => p.getTreeNode());
            }
        }
        else if (!this.loaded) {
            return [new TreeNode('No SVD file loaded (www.keil.com/dd2/)', vscode.TreeItemCollapsibleState.None, 'message', null)];
        }
        else {
            return [];
        }
    }

    public debugSessionStarted(svdfile: string): Thenable<any> {
        return new Promise((resolve, reject) => {
            this.peripherials = [];
            this.loaded = false;
            this._onDidChangeTreeData.fire();
            
            if (svdfile) {
                setTimeout(() => {
                    this._loadSVD(svdfile).then(
                        () => {
                            vscode.workspace.findFiles('.vscode/.cortex-debug.peripherals.state.json', null, 1).then((value) => {
                                if (value.length > 0) {
                                    const fspath = value[0].fsPath;
                                    const data = fs.readFileSync(fspath, 'utf8');
                                    const settings = JSON.parse(data);
                                    settings.forEach((s: NodeSetting) => {
                                        const node = this._findNodeByPath(s.node);
                                        if (node) {
                                            node.expanded = s.expanded || false;
                                            node.format = s.format;
                                        }
                                    });
                                    this._onDidChangeTreeData.fire();
                                }
                            }, (error) => {

                            });
                            this._onDidChangeTreeData.fire();
                            resolve();
                            reporting.sendEvent('Peripheral View', 'Used', svdfile);
                        },
                        (e) => {
                            this.peripherials = [];
                            this.loaded = false;
                            this._onDidChangeTreeData.fire();
                            vscode.window.showErrorMessage(`Unable to parse SVD file: ${e.toString()}`);
                            resolve();
                            reporting.sendEvent('Peripheral View', 'Error', e.toString());
                        }
                    );
                }, 150);
            }
            else {
                resolve();
                reporting.sendEvent('Peripheral View', 'No SVD');
            }
        });
    }

    public debugSessionTerminated(): Thenable<any> {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const fspath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode', '.cortex-debug.peripherals.state.json');
            this._saveState(fspath);
        }
        
        this.peripherials = [];
        this.loaded = false;
        this._onDidChangeTreeData.fire();
        return Promise.resolve(true);
    }

    public debugStopped() {
        if (this.loaded) {
            const promises = this.peripherials.map((p) => p.update());
            Promise.all(promises).then((_) => { this._onDidChangeTreeData.fire(); }, (_) => { this._onDidChangeTreeData.fire(); });
        }
    }

    public debugContinued() {
        
    }
}
