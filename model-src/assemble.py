"""在 Blender 里把 OSR2 的 10 个部件按「立姿（L0/R1/R2/R0 = 50%）」组装出来，
方便直接拖动部件调整位置。

用法：
    双击 model-src\\打开Blender调模型.bat
  1) 左边大纲里出现 16 个对象（leftArm__arm、receiver__receiver ……）
  2) 选中对象 G 移动 / R 旋转
  3) 视口右侧按 N → 打开「OSR2」标签 → 点「导出偏移到网页」
     偏移会写到 model-src\\model-offsets.json 和 ..\\static\\model-offsets.json
     浏览器 Ctrl+F5 后生效
  4) 想撤销：点「清空偏移」
"""
import bpy
import json
import mathutils
import os

PARTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parts')
REST_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rest.json')
OUT_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'model-offsets.json')
STATIC_JSON = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static', 'model-offsets.json')
EPS = 1e-4


def _import_obj(path, obj_name):
    # 用「刚导入后被选中的对象」定位新对象，避免同名网格（arm/bearing/joint 被多处复用）导致错位
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.wm.obj_import(filepath=path, forward_axis='Y', up_axis='Z')
    picked = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    if not picked:
        picked = [o for o in bpy.context.view_layer.objects if o.type == 'MESH']
    obj = picked[0]
    obj.name = obj_name
    if obj.data:
        obj.data.name = obj_name + '_mesh'
    bpy.ops.object.select_all(action='DESELECT')
    return obj


def assemble():
    with open(REST_JSON, 'r', encoding='utf-8') as f:
        rest = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    made = 0
    for key, info in rest['parts'].items():
        path = os.path.join(PARTS_DIR, info['mesh'] + '.obj')
        if not os.path.exists(path):
            print('缺少', path)
            continue
        obj = _import_obj(path, key + '__' + info['mesh'])
        obj.location = info['pos']
        q = info['quat']
        obj.rotation_mode = 'QUATERNION'
        obj.rotation_quaternion = mathutils.Quaternion((q[3], q[0], q[1], q[2]))
        obj['osr_part'] = key
        obj['rest_pos'] = info['pos']
        obj['rest_quat'] = q
        made += 1
    print('已导入 %d 个部件；按 N 打开「OSR2」面板导出偏移。' % made)
    return made


def export_offsets():
    # 后台模式下 matrix_world 是惰性求值的，必须先刷新，否则读到的是单位矩阵
    try:
        bpy.context.view_layer.update()
    except Exception as e:
        print('view_layer.update 失败：', e)
    offsets = {}
    for obj in bpy.data.objects:
        if obj.type != 'MESH' or 'osr_part' not in obj:
            continue
        key = obj['osr_part']
        rq = obj['rest_quat']
        rest_quat = mathutils.Quaternion((rq[3], rq[0], rq[1], rq[2]))
        rest_pos = mathutils.Vector(obj['rest_pos'])
        dq = obj.matrix_world.to_quaternion() @ rest_quat.inverted()
        dp = obj.matrix_world.to_translation() - rest_pos
        moved = max(abs(dp.x), abs(dp.y), abs(dp.z)) > EPS
        turned = abs(dq.angle) > EPS
        if not (moved or turned):
            continue
        offsets[key] = {
            'pos': [round(dp.x, 4), round(dp.y, 4), round(dp.z, 4)],
            'quat': [round(dq.x, 6), round(dq.y, 6), round(dq.z, 6), round(dq.w, 6)],
        }
    data = {'note': 'model-src/export_offsets.py: per-part offset (device space)', 'offsets': offsets}
    for target in (OUT_JSON, STATIC_JSON):
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            print('已写出', target)
        except Exception as e:
            print('写出失败', target, e)
    print('有偏移的部件：%s' % ('、'.join(offsets.keys()) if offsets else '（无）'))
    return offsets


def clear_offsets():
    return export_offsets.__self__ if False else _write_empty()


def _write_empty():
    data = {'note': 'model-src/export_offsets.py: per-part offset (device space)', 'offsets': {}}
    for target in (OUT_JSON, STATIC_JSON):
        with open(target, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
    print('已清空偏移表')


class OSR2_OT_export(bpy.types.Operator):
    bl_idname = 'osr2.export_offsets'
    bl_label = '导出偏移到网页'

    def execute(self, context):
        export_offsets()
        self.report({'INFO'}, '偏移表已写出，浏览器 Ctrl+F5 生效')
        return {'FINISHED'}


class OSR2_OT_clear(bpy.types.Operator):
    bl_idname = 'osr2.clear_offsets'
    bl_label = '清空偏移'

    def execute(self, context):
        _write_empty()
        self.report({'INFO'}, '偏移已清空')
        return {'FINISHED'}


class OSR2_PT_panel(bpy.types.Panel):
    bl_label = 'OSR2 调模型'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'OSR2'

    def draw(self, context):
        col = self.layout.column(align=True)
        col.label(text='1) 选中部件，G 移动 / R 旋转')
        col.label(text='2) 调好后点下面按钮')
        col.separator()
        col.operator('osr2.export_offsets', icon='EXPORT')
        col.operator('osr2.clear_offsets', icon='TRASH')


def register():
    try:
        bpy.utils.register_class(OSR2_OT_export)
        bpy.utils.register_class(OSR2_OT_clear)
        bpy.utils.register_class(OSR2_PT_panel)
    except Exception as e:
        print('面板注册跳过（可能已注册）：', e)


def main():
    if bpy.app.background:
        assemble()
        register()
        return
    assemble()
    register()
    for area in bpy.context.screen.areas if bpy.context.screen else []:
        if area.type == 'VIEW_3D':
            for region in area.regions:
                if region.type == 'WINDOW':
                    with bpy.context.temp_override(area=area, region=region):
                        bpy.ops.view3d.view_all(center=True)


main()
