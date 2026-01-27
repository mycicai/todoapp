#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

API_URL="http://localhost:3000/api"
TOKEN=""

# 测试函数
test_endpoint() {
  local method=$1
  local endpoint=$2
  local data=$3
  local expected_status=$4

  echo -e "\n${YELLOW}测试: $method $endpoint${NC}"

  # build header
  local auth_header=""
  if [ -n "$TOKEN" ]; then
    auth_header="Authorization: Bearer $TOKEN"
  fi

  local response
  if [ -n "$data" ]; then
    if [ -n "$auth_header" ]; then
      response=$(curl -s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json" -H "$auth_header" -d "$data" "$API_URL$endpoint")
    else
      response=$(curl -s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json" -d "$data" "$API_URL$endpoint")
    fi
  else
    if [ -n "$auth_header" ]; then
      response=$(curl -s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json" -H "$auth_header" "$API_URL$endpoint")
    else
      response=$(curl -s -w '\n%{http_code}' -X "$method" -H "Content-Type: application/json" "$API_URL$endpoint")
    fi
  fi

  local status
  status=$(echo "$response" | tail -1)
  # remove the last line (status code) in a portable way
  local body
  body=$(echo "$response" | sed '$d')

  if [ "$status" = "$expected_status" ]; then
    echo -e "${GREEN}✓ 状态码: $status${NC}"
    echo "响应: $body" | head -c 100
    echo "..."
  else
    echo -e "${RED}✗ 期望状态码: $expected_status, 实际: $status${NC}"
    echo "响应: $body"
    return 1
  fi

  echo "$body"
}

# 测试健康检查
echo -e "\n${YELLOW}========== 健康检查 ==========${NC}"
test_endpoint "GET" "/health" "" "200"

# 测试注册
echo -e "\n${YELLOW}========== 用户认证测试 ==========${NC}"
REGISTER_DATA='{"username":"testuser","email":"test@example.com","password":"testpass123"}'
register_response=$(test_endpoint "POST" "/auth/register" "$REGISTER_DATA" "201")

# 测试登录
LOGIN_DATA='{"username":"testuser","password":"testpass123"}'
login_response=$(test_endpoint "POST" "/auth/login" "$LOGIN_DATA" "200")

# 提取token
TOKEN=$(echo "$login_response" | grep -o '"token":"[^"]*' | cut -d'"' -f4)
# 清理可能的换行和回车
TOKEN=$(echo "$TOKEN" | tr -d '\r\n')

if [ -z "$TOKEN" ]; then
  echo -e "${RED}✗ 无法获取Token${NC}"
  exit 1
fi

echo -e "\n${GREEN}✓ 成功获取Token: ${TOKEN:0:20}...${NC}"

# 测试获取用户信息
echo -e "\n${YELLOW}========== 用户信息测试 ==========${NC}"
test_endpoint "GET" "/auth/me" "" "200"

# 测试创建TODO
echo -e "\n${YELLOW}========== TODO操作测试 ==========${NC}"
TODO_DATA1='{"text":"学习Node.js","priority":"high"}'
todo_response=$(test_endpoint "POST" "/todos" "$TODO_DATA1" "201")
TODO_ID=$(echo "$todo_response" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)

echo -e "\n${GREEN}✓ 创建的TODO ID: $TODO_ID${NC}"

# 创建第二个TODO
TODO_DATA2='{"text":"完成项目文档","priority":"normal"}'
test_endpoint "POST" "/todos" "$TODO_DATA2" "201"

# 获取所有TODO
echo -e "\n${YELLOW}========== 获取TODO列表 ==========${NC}"
test_endpoint "GET" "/todos" "" "200"

# 更新TODO
echo -e "\n${YELLOW}========== 更新TODO ==========${NC}"
UPDATE_DATA='{"completed":true,"text":"学习Node.js和Express"}'
test_endpoint "PUT" "/todos/$TODO_ID" "$UPDATE_DATA" "200"

# 获取会话列表
echo -e "\n${YELLOW}========== 会话管理测试 ==========${NC}"
test_endpoint "GET" "/auth/sessions" "" "200"

# 修改密码
echo -e "\n${YELLOW}========== 修改密码测试 ==========${NC}"
PASSWORD_DATA='{"oldPassword":"testpass123","newPassword":"newpass456"}'
test_endpoint "POST" "/auth/change-password" "$PASSWORD_DATA" "200"

# 验证新密码可以登录
echo -e "\n${YELLOW}========== 验证新密码 ==========${NC}"
NEW_LOGIN_DATA='{"username":"testuser","password":"newpass456"}'
test_endpoint "POST" "/auth/login" "$NEW_LOGIN_DATA" "200"

# 清除已完成的TODO
echo -e "\n${YELLOW}========== 清除已完成TODO ==========${NC}"
test_endpoint "DELETE" "/todos/batch/completed" "" "200"

# 删除TODO
echo -e "\n${YELLOW}========== 删除TODO ==========${NC}"
test_endpoint "DELETE" "/todos/$TODO_ID" "" "200"

# 测试登出
echo -e "\n${YELLOW}========== 登出测试 ==========${NC}"
test_endpoint "POST" "/auth/logout" "" "200"

echo -e "\n${GREEN}========== 所有测试完成! ==========${NC}\n"
