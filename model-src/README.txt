===========================================================
OSR2 模型：Blender 调位置 → 网页预览生效
===========================================================

一、打开 Blender 组装模型
  双击  打开Blender调模型.bat
  （等价命令：blender --python "本目录\assemble.py"
    先用 `where blender` 确认 Blender 在 PATH 里；装在别处就改 .bat 里的 BLENDER 变量）

  打开后左边大纲里是 16 个对象，命名是「部件名__网格名」：
      base__base            底座
      lid__lid              上盖（那块竖板）
      pitcher__pitcher      管身
      receiver__receiver    接收器（杯子）
      modCase__modCase      外壳（外面那层大壳）
      leftArm__arm          左臂（x=+70）
      rightArm__arm         右臂（x=-70）
      pitcherArm__pitcherArm        舵机摇臂（只跟 R2 俯仰动）
      pitcherLinkArm__pitcherLinkArm 连杆
      leftBearing__bearing / rightBearing__bearing / linkStartBearing__bearing
      linkEndBearing__bearing / leftJoint__joint / rightJoint__joint / linkJoint__joint
      （bearing / joint 是同一个网格被多个零件复用，改名区分）

二、调整
  选中对象后：
      G              移动（再按 X / Y / Z 锁定轴向，或直接输数字）
      R              旋转
      Alt+G / Alt+R  还原这个对象
  坐标轴：Z 向上、X 左右、Y 前后，单位与模型一致（底座宽约 118）
  你在 Blender 里改的是「相对立姿的偏移」，网页里的运动学不会被覆盖。

三、把偏移写回网页
  在 3D 视口按 N → 右侧出现「OSR2」标签 → 点「导出偏移到网页」
  会写出：
      model-src\model-offsets.json
      static\model-offsets.json     ← 网页读这个
  然后浏览器 Ctrl+F5，动作库页的 3D 预览就会按你的调整显示。
  点「清空偏移」= 恢复原版位置。

四、改网格（不是挪位置）
  1) 在 Blender 里编辑顶点/雕刻后，选中该对象
  2) 文件 → 导出 → Wavefront (.obj)，勾选「仅选中」，
     轴向用 向前 = Y、向上 = Z（与导入一致）
  3) 覆盖 model-src\parts\<网格名>.obj（例如 arm.obj / modCase.obj）
  4) 双击 重建模型.bat  → 重新打包 static\device-osr2.bin
  5) Ctrl+F5
  注：重建脚本会按固定顺序打包 10 个网格，网格名必须原样保留。
     （已验证：不修改任何东西直接重建，输出与原文件逐字节相同）

五、文件一览
  parts\              10 个部件 OBJ（局部坐标）
  rest.json           立姿（L0/R1/R2/R0=50%）下每个部件的位置 + 四元数
  assemble.py         组装脚本 + Blender 里的「OSR2」面板
  rebuild_bin.py      parts\*.obj → static\device-osr2.bin
  打开Blender调模型.bat
  重建模型.bat