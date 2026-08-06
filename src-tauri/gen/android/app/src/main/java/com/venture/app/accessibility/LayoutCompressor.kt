package com.venture.app.accessibility

import org.json.JSONArray
import org.json.JSONObject

/**
 * 布局树压缩（对应规格书 3.5 brief 模式）。
 *
 * 步骤：
 * 1. 裁剪：仅保留满足任一条件的节点（text/desc 非空、可交互、有 id、depth <= maxDepth）
 * 2. 编号：按 DFS 顺序对保留节点重新编号（id 字段）——VLM 对齐的关键：
 *    截图给 LLM 看、编号树给坐标，LLM 输出"点击节点 42"，执行器查 nodeMap 转坐标
 * 3. 上限：节点数 > nodeLimit 时按优先级截断，根节点附带 "truncated": true
 */
object LayoutCompressor {

    const val DEFAULT_MAX_DEPTH = 6
    const val DEFAULT_NODE_LIMIT = 200
    const val NOTICE = "坐标与 actions 为准，text 可能为空（自绘控件）"

    class Compressed(
        val root: JSONObject,
        /** 节点编号 -> 原始快照（click(node_id) 查表转坐标用） */
        val nodeMap: Map<Int, NodeInfo>,
        val truncated: Boolean,
    )

    fun compress(
        root: NodeInfo,
        maxDepth: Int = DEFAULT_MAX_DEPTH,
        nodeLimit: Int = DEFAULT_NODE_LIMIT,
    ): Compressed {
        // 1. 裁剪 + DFS 收集保留节点（保持父子关系）
        val kept = mutableListOf<NodeInfo>()
        val keptChildren = HashMap<NodeInfo, MutableList<NodeInfo>>()

        fun prune(node: NodeInfo): Boolean {
            val childrenKept = mutableListOf<NodeInfo>()
            node.children.forEach { child ->
                if (prune(child)) childrenKept.add(child)
            }
            val keepSelf = node.isBriefWorthy(maxDepth)
            // 父节点不满足条件但有保留子节点时，也需保留以维持树结构（透明容器）
            val keep = keepSelf || childrenKept.isNotEmpty()
            if (keep) {
                kept.add(node)
                keptChildren[node] = childrenKept
            }
            return keep
        }
        prune(root)
        if (kept.isEmpty()) {
            // 根都不保留的极端情况：强制保留根
            kept.add(root)
            keptChildren[root] = mutableListOf()
        }

        // 2. 截断：超过上限时按优先级保留（根永远保留；树可不连通，由下方上提逻辑处理）
        var truncated = false
        val finalSet: Set<NodeInfo> = if (kept.size > nodeLimit) {
            truncated = true
            val sorted = kept.sortedWith(compareBy({ it.briefPriority() }, { it.depth }))
            val chosen = sorted.take(nodeLimit).toHashSet()
            chosen.add(root)
            chosen
        } else {
            kept.toHashSet()
        }

        // 3. DFS 编号 + 生成 JSON（被裁剪/截断的父节点，其保留后代递归上提到最近保留祖先）
        // 互相递归的局部函数无法前向引用，放入内部 Builder 类
        val builder = Builder(finalSet, keptChildren)
        val rootJson = builder.buildJson(root) ?: root.toJson(builder.nextId).also {
            builder.nodeMap[builder.nextId] = root
        }
        if (truncated) rootJson.put("truncated", true)
        rootJson.put("notice", NOTICE)

        return Compressed(rootJson, builder.nodeMap, truncated)
    }

    private class Builder(
        private val finalSet: Set<NodeInfo>,
        private val keptChildren: Map<NodeInfo, List<NodeInfo>>,
    ) {
        val nodeMap = HashMap<Int, NodeInfo>()
        var nextId = 0

        fun buildJson(node: NodeInfo): JSONObject? {
            if (node !in finalSet) return null
            val id = nextId++
            nodeMap[id] = node
            val o = node.toJson(id)
            val arr = JSONArray()
            appendDescendants(node, arr)
            o.put("children", arr)
            return o
        }

        private fun appendDescendants(node: NodeInfo, arr: JSONArray) {
            val children = keptChildren[node] ?: node.children
            children.forEach { child ->
                val childJson = buildJson(child)
                if (childJson != null) {
                    arr.put(childJson)
                } else {
                    appendDescendants(child, arr)
                }
            }
        }
    }
}
