"""生成不含个人路径的 Finder 安装布局，常规构建只复制已生成模板。

再生工具：python -m pip install ds_store==1.3.3 mac_alias==2.2.3
格式参考：https://ds-store.readthedocs.io/ 与 dmgbuild 官方实现。
"""

from pathlib import Path
from ds_store import DSStore

destination = Path(__file__).resolve().parent.parent / "desktop" / "InstallLayout.store"
window = {
    "WindowBounds": "{{280, 160}, {640, 420}}",
    "ShowToolbar": False,
    "ShowStatusBar": False,
    "ShowPathbar": False,
    "ShowSidebar": False,
    "ShowTabView": False,
    "ContainerShowSidebar": False,
    "PreviewPaneVisibility": False,
    "SidebarWidth": 0,
}
icons = {
    "viewOptionsVersion": 1,
    "backgroundType": 0,
    "arrangeBy": "none",
    "iconSize": 96.0,
    "textSize": 14.0,
    "gridSpacing": 100.0,
    "gridOffsetX": 0.0,
    "gridOffsetY": 0.0,
    "scrollPositionX": 0.0,
    "scrollPositionY": 0.0,
    "labelOnBottom": True,
    "showIconPreview": False,
    "showItemInfo": False,
}
with DSStore.open(str(destination), "w+") as store:
    store["."]["vSrn"] = ("long", 1)
    store["."]["bwsp"] = window
    store["."]["icvp"] = icons
    store["."]["icvl"] = ("type", b"icnv")
    store["织识.app"]["Iloc"] = (150, 130)
    store["Applications"]["Iloc"] = (490, 130)
    store["安装与备份说明.html"]["Iloc"] = (320, 290)

print(destination.name)
